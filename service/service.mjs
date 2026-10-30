// The BrowserBear service: one per Mac, on a Unix socket. Native hosts (one per
// Chrome profile with the extension) and clients (the CLI, Threadbear) both
// connect here. Hosts say hello first; anything else is a client sending
// { id, cmd, args } and getting back { id, ok, result | error }.
//
// The page logic lives here rather than in the extension, so changing how
// snapshots or clicks work never needs a new extension release.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME, LOGS, OUT, SOCKET, line, lineReader } from './wire.mjs';
import { createMarks } from './marks.mjs';
import { RefMap, compact, diff, sameApartFromFocus } from './snapshot.mjs';

fs.mkdirSync(LOGS, { recursive: true, mode: 0o700 });
fs.mkdirSync(OUT, { recursive: true, mode: 0o700 });
const logFile = fs.createWriteStream(path.join(LOGS, 'service.log'), { flags: 'a' });
const log = (...a) => logFile.write(`${new Date().toISOString()} ${a.join(' ')}\n`);

const LOCAL_STATE =
  process.env.BROWSERBEAR_CHROME_LOCAL_STATE || path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'Local State');
const SETTLE_MS = 600; // after an action, before the follow-up snapshot

// instance -> { conn, email, name, dir, pending: Map<id, {resolve, reject, timer}> }
const profiles = new Map();
const tabOwner = new Map(); // tabId -> instance
const bearTabs = new Set(); // tabs BrowserBear opened itself (in its own window)
const tabState = new Map(); // tabId -> { refs: RefMap, last: string[] | null, dialog }
const sentTo = new Map(); // tabId -> pages an agent opened or sent it to
let nextId = 1;

// Chrome's own list of profiles, so "Work" or "Profile 2" or the email
// all find the same one. Read fresh each time: profiles come and go.
function chromeProfiles() {
  try {
    const cache = JSON.parse(fs.readFileSync(LOCAL_STATE, 'utf8')).profile?.info_cache || {};
    return Object.entries(cache).map(([dir, p]) => ({ dir, name: p.name, email: p.user_name || null }));
  } catch {
    return [];
  }
}

function describe(p) {
  return p.name ? `${p.name}${p.email ? ` (${p.email})` : ''}` : p.email || p.instance.slice(0, 8);
}

function findProfile(want) {
  const all = [...profiles.values()];
  if (!want) {
    if (all.length === 1) return all[0];
    throw new Error(`say which profile: ${all.map(describe).join(', ') || 'none connected'}`);
  }
  const w = want.toLowerCase();
  const hit =
    all.find((p) => [p.name, p.email, p.dir].some((v) => v?.toLowerCase() === w)) ||
    all.find((p) => [p.name, p.email].some((v) => v?.toLowerCase().includes(w)));
  if (!hit) throw new Error(`no connected profile matches "${want}"; connected: ${all.map(describe).join(', ') || 'none'}`);
  return hit;
}

function call(profile, op, args = {}, timeoutMs = 30_000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      profile.pending.delete(id);
      reject(Object.assign(new Error(`${op} timed out after ${timeoutMs / 1000}s in ${describe(profile)}`), { timedOut: true }));
    }, timeoutMs);
    profile.pending.set(id, { resolve, reject, timer, tabId: args.tabId });
    profile.conn.write(line({ id, op, args }));
  });
}

async function ownerOf(tabId) {
  const known = profiles.get(tabOwner.get(tabId));
  if (known) return known;
  for (const p of profiles.values()) {
    const tabs = await call(p, 'tabs');
    for (const t of tabs) tabOwner.set(t.tabId, p.instance);
  }
  const found = profiles.get(tabOwner.get(tabId));
  if (!found) throw new Error(`no tab ${tabId} in any connected profile (browserbear tabs lists them)`);
  return found;
}

const marks = createMarks({
  send: async (tabId, mark) => call(await ownerOf(tabId), 'mark', { tabId, mark }, 5_000),
  log,
});

// What the pill in an agent's tab says it's doing, per command.
const USES = {
  snap: () => 'looking at the page',
  click: ({ tab, ref }) => `clicking ${labelOf(tab, ref)}`,
  type: () => 'typing',
  key: ({ key }) => `pressing ${key}`,
  goto: ({ url }) => `going to ${hostOf(url)}`,
  read: () => 'reading the page',
  shot: () => 'taking a screenshot',
  eval: () => 'running a script',
  cdp: () => 'working',
  upload: () => 'uploading a file',
  download: () => 'downloading a file',
  dialog: () => 'answering a dialog',
  show: () => 'looking at the page',
};

// "Post" for e12 when the last snapshot had `e12 button "Post"`.
function labelOf(tabId, ref) {
  const line = tabState.get(tabId)?.last?.find((l) => l.startsWith(`${ref} `));
  const name = line && /"(.*)"/.exec(line)?.[1];
  return name ? `"${name.length > 40 ? `${name.slice(0, 39)}…` : name}"` : 'something';
}

function hostOf(url) {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

const state = (tabId) => {
  if (!tabState.has(tabId)) tabState.set(tabId, { refs: new RefMap(), last: null, dialog: null });
  return tabState.get(tabId);
};

// How long a command gets before BrowserBear asks why it hasn't come back.
// An env var so tests needn't wait 20 s.
const CDP_WAIT_MS = Number(process.env.BROWSERBEAR_CDP_WAIT_MS) || 20_000;
const PROBE_MS = Math.min(4_000, CDP_WAIT_MS);

async function cdp(tabId, method, params, timeoutMs = CDP_WAIT_MS) {
  const p = await ownerOf(tabId);
  // Input has its own short wait, where running out means "probably landed".
  if (method.startsWith('Input.')) return call(p, 'cdp', { tabId, method, params }, timeoutMs);
  if (state(tabId).stuck) await stillStuck(p, tabId);
  try {
    return await call(p, 'cdp', { tabId, method, params }, timeoutMs);
  } catch (e) {
    if (!e.timedOut) throw e;
    return unstick(p, tabId, method, params, e);
  }
}

// Commands that only look, so sending one again can't do anything twice.
const LOOKS = /^(Accessibility\.get|DOM\.(get|describe|resolve|querySelector)|Page\.(enable|getNavigationHistory|captureScreenshot)$|Runtime\.enable$)/;

// A command that never came back, as every one did for a BTC Markets tab
// (30 Oct) while the profile's other tabs answered. Two ways that happens:
//  - The page's own main thread is stuck or flat out (a live chart, a hung
//    script). Everything that has to go to the page waits behind it, even
//    attaching again, but Chrome answers the browser-side commands by itself,
//    so Page.getNavigationHistory still comes back.
//  - The debugger session is stuck, and even that doesn't come back. A fresh
//    session (detach; the next command attaches again) clears it.
// Either way the agent hears which, rather than another 20 s timeout.
async function unstick(p, tabId, method, params, e) {
  const history = () => call(p, 'cdp', { tabId, method: 'Page.getNavigationHistory', params: {} }, PROBE_MS);
  const nav = await history().catch(() => null);
  if (nav) {
    // An eval awaiting a slow promise doesn't hold the page up.
    if (await pageAnswers(p, tabId)) throw new Error(`${e.message}; the page still answers, so it's that command that's slow`);
    const url = nav.entries[nav.currentIndex]?.url || '';
    state(tabId).stuck = { url };
    log('page stuck', tabId, method);
    throw new Error(stuckPage(tabId, url));
  }
  log('session stuck', tabId, method);
  await call(p, 'detach', { tabId }, PROBE_MS).catch(() => {});
  if (!(await history().catch(() => null))) {
    const url = (await call(p, 'tabs').catch(() => [])).find((t) => t.tabId === tabId)?.url || '';
    throw new Error(`tab ${tabId}'s debugger session is stuck and starting a fresh one didn't help; reopen the page in a new tab: browserbear open ${url || '<url>'}`);
  }
  if (LOOKS.test(method)) return call(p, 'cdp', { tabId, method, params }, CDP_WAIT_MS);
  // It may have run before the session stuck, so it isn't sent again.
  throw new Error(`tab ${tabId}'s debugger session was stuck, so BrowserBear started a fresh one; ${method} may or may not have run, snap to see before trying again`);
}

const stuckPage = (tabId, url) =>
  `tab ${tabId}'s page isn't answering: Chrome is fine, but the page's own scripts are stuck or flat out (a live chart can do this). Try again in a bit, or open it fresh in a new tab: browserbear open ${url || '<url>'}`;

// Once a page has been stuck, a quick look first, so each command after it
// doesn't wait the full 20 s to say the same thing.
async function stillStuck(p, tabId) {
  const s = state(tabId);
  if (!(await pageAnswers(p, tabId))) throw new Error(stuckPage(tabId, s.stuck.url));
  s.stuck = null;
}

const pageAnswers = (p, tabId) =>
  call(p, 'cdp', { tabId, method: 'Runtime.evaluate', params: { expression: '1' } }, PROBE_MS).then(() => true, () => false);

// Is the element at (x, y) the one we mean, or something inside it? A dialog
// still animating in, a toast or a transparent overlay can sit on top, and a
// real click then lands on that instead (Sentry's Remove Project dialog, 29 Oct).
async function hitsTarget(tabId, backendNodeId, at) {
  const hit = await cdp(tabId, 'DOM.getNodeForLocation', { x: Math.round(at.x), y: Math.round(at.y), ignorePointerEventsNone: true }).catch(() => null);
  if (!hit?.backendNodeId) return { ok: false, what: 'nothing' };
  if (hit.backendNodeId === backendNodeId) return { ok: true };
  const [{ object: target }, { object: top }] = await Promise.all([
    cdp(tabId, 'DOM.resolveNode', { backendNodeId }),
    cdp(tabId, 'DOM.resolveNode', { backendNodeId: hit.backendNodeId }),
  ]);
  const { result } = await cdp(tabId, 'Runtime.callFunctionOn', {
    objectId: target.objectId,
    arguments: [{ objectId: top.objectId }],
    functionDeclaration: `function (top) {
      const el = top.nodeType === 1 ? top : top.parentElement;
      if (this === el || this.contains(el)) return '';
      return (el.getAttribute('aria-label') || el.tagName.toLowerCase()) + (el.id ? '#' + el.id : '');
    }`,
    returnByValue: true,
  });
  return result.value ? { ok: false, what: result.value } : { ok: true };
}

const isLink = async (tabId, backendNodeId) => {
  const { object } = await cdp(tabId, 'DOM.resolveNode', { backendNodeId });
  const { result } = await cdp(tabId, 'Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: `function () { return !!this.closest?.('a[href]'); }`, returnByValue: true });
  return result?.value === true;
};

async function scriptClick(tabId, backendNodeId) {
  const { object } = await cdp(tabId, 'DOM.resolveNode', { backendNodeId });
  await cdp(tabId, 'Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: SCRIPT_CLICK });
}

// Chrome only answers an input event once the page has handled it, and a busy
// page (App Store Connect, 29 Oct) can take longer than any sane timeout even
// though the click landed. So input gets a shorter wait, and running out of
// it means "probably done, look before retrying", not an error.
const INPUT_WAIT_MS = 8_000;

async function nodeFor(tabId, ref) {
  const backendNodeId = state(tabId).refs.node(ref);
  if (!backendNodeId) throw new Error(`unknown ref ${ref} in tab ${tabId}; take a snapshot first`);
  return backendNodeId;
}

const dialogLine = (tabId, d) => `[js ${d.type} "${d.message}" is open; nothing else works until: browserbear dialog ${tabId} accept|dismiss]`;

// Every <input type=file> in the page, keyed by backendNodeId. Hidden ones
// aren't in the accessibility tree, and they're the ones upload needs.
async function fileInputs(tabId) {
  try {
    const { root } = await cdp(tabId, 'DOM.getDocument', { depth: 0 });
    const { nodeIds } = await cdp(tabId, 'DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'input[type=file]' });
    if (!nodeIds.length) return new Map();
    // A styled <label> isn't a control in the tree, so its text is the only
    // name the input has. Same order as querySelectorAll above.
    const [nodes, labels] = await Promise.all([
      Promise.all(nodeIds.map((nodeId) => cdp(tabId, 'DOM.describeNode', { nodeId }).then((r) => r.node))),
      evaluate(tabId, `[...document.querySelectorAll('input[type=file]')].map((i) => i.labels?.[0]?.innerText || i.getAttribute('aria-label') || i.title || '')`).catch(() => []),
    ]);
    return new Map(
      nodes.map((n, i) => {
        const a = {};
        for (let j = 0; j < (n.attributes?.length || 0); j += 2) a[n.attributes[j]] = n.attributes[j + 1];
        return [n.backendNodeId, { id: a.id, label: labels[i], accept: a.accept, multiple: 'multiple' in a, disabled: 'disabled' in a }];
      }),
    );
  } catch {
    return new Map(); // a snapshot without them beats no snapshot
  }
}

async function snapshot(tabId, { full = false } = {}) {
  const s = state(tabId);
  // A JS dialog freezes the page, so every other call would just time out.
  if (s.dialog) return `tab ${tabId}\n${dialogLine(tabId, s.dialog)}`;
  await cdp(tabId, 'Page.enable');
  const [{ nodes }, files] = await Promise.all([cdp(tabId, 'Accessibility.getFullAXTree'), fileInputs(tabId)]);
  const lines = compact(nodes, s.refs, files);
  const out = full ? { full: true, text: lines.join('\n') } : diff(s.last, lines);
  s.last = lines;
  const tab = (await call(await ownerOf(tabId), 'tabs')).find((t) => t.tabId === tabId);
  const head = `tab ${tabId}: ${tab?.title || ''} <${tab?.url || ''}>`;
  return `${head}\n${out.text}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = () => sleep(SETTLE_MS);

// A click or key that submits a form starts a navigation that can outlast the
// settle, and the snapshot then shows the old page as "(no change)" (GOV.UK's
// Continue buttons, 30 Oct). So the page is marked before acting: still
// marked "here" afterwards means it stayed; "leaving" (beforeunload fired, the
// next page hasn't arrived) or no mark (a new document) means wait for the
// new page to load.
const MARK = `window.__browserbear = 'here'; addEventListener('beforeunload', () => { window.__browserbear = 'leaving'; }); true`;

async function markPage(tabId) {
  await evaluate(tabId, MARK).catch(() => {});
}

async function settleAfterAction(tabId, timeoutMs = 20_000) {
  await settle();
  const until = Date.now() + timeoutMs;
  // A beforeunload with no navigation after it (a download link) would
  // otherwise wait the full timeout.
  const leavingUntil = Date.now() + 8_000;
  let navigated = false;
  while (Date.now() < until) {
    // Mid-navigation there may be no context to evaluate in yet.
    const [mark, ready] = (await evaluate(tabId, `[window.__browserbear ?? null, document.readyState]`).catch(() => null)) || ['leaving'];
    if (mark === 'here') break;
    if (mark === null) navigated = true;
    if (mark === 'leaving' && !navigated && Date.now() > leavingUntil) break;
    if (mark === null && ready === 'complete') {
      await settle(); // the new page's own scripts drawing it
      break;
    }
    await sleep(250);
  }
}

async function center(tabId, backendNodeId) {
  await cdp(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => {});
  const { quads } = await cdp(tabId, 'DOM.getContentQuads', { backendNodeId });
  if (!quads?.length) return null;
  const q = quads[0];
  return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 };
}

// Chrome holds back real input on tabs you can't see (15 s for one mouse
// event on a background tab, 29 Oct), so: BrowserBear's own tabs are brought to the
// front of BrowserBear's window; your tabs are never pulled forward behind your back,
// and get a script click instead, which most sites accept.
async function clickNode(tabId, backendNodeId, { script = false } = {}) {
  const p = await ownerOf(tabId);
  let tab = (await call(p, 'tabs')).find((t) => t.tabId === tabId);
  if (!tab?.active && bearTabs.has(tabId)) tab = await call(p, 'show', { tabId });
  if (script) {
    await scriptClick(tabId, backendNodeId);
    return '(script click, as asked)';
  }
  const at = tab?.active ? await center(tabId, backendNodeId) : null;
  if (!at) {
    await scriptClick(tabId, backendNodeId);
    return tab?.active ? '' : `(tab ${tabId} is in the background, so that was a script click; browserbear show ${tabId} brings it forward for a real one)`;
  }
  const hit = await hitsTarget(tabId, backendNodeId, at);
  if (!hit.ok) {
    await scriptClick(tabId, backendNodeId);
    return `(${hit.what} was on top of it, so that was a script click)`;
  }
  const base = { x: at.x, y: at.y, button: 'left', clickCount: 1 };
  // No separate mouseMoved first: each input event waits for the page to draw
  // a frame (1.5-3 s apiece on a busy Mac, 29 Oct), and pressed at x,y
  // already moves the pointer there.
  try {
    await cdp(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mousePressed' }, INPUT_WAIT_MS);
    await cdp(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' }, INPUT_WAIT_MS);
  } catch (e) {
    if (!/timed out/.test(e.message)) throw e;
    return `(the page hadn't confirmed the click after ${INPUT_WAIT_MS / 1000} s, so it's busy; the click has probably landed, check below before retrying)`;
  }
  return '';
}

// The full pointer sequence, not just click(): menus and comboboxes (Base UI,
// Radix) open on pointerdown and ignore a bare click event.
const SCRIPT_CLICK = `function () {
  const o = { bubbles: true, cancelable: true, composed: true, view: window, button: 0 };
  this.scrollIntoView({ block: 'center' });
  this.dispatchEvent(new PointerEvent('pointerdown', { ...o, pointerType: 'mouse', isPrimary: true }));
  this.dispatchEvent(new MouseEvent('mousedown', o));
  this.focus?.();
  this.dispatchEvent(new PointerEvent('pointerup', { ...o, pointerType: 'mouse', isPrimary: true }));
  this.dispatchEvent(new MouseEvent('mouseup', o));
  this.click();
}`;

// What upload sets files on. Sites hide the real <input type=file> behind a
// styled button or label (Adobe Podcast Enhance, 30 Oct), so a target that
// isn't one is followed to the input it stands for: a label's control, one
// inside it, or one named by for= or aria-controls.
const LINKED_FILE_INPUT = `function () {
  const isFile = (el) => el instanceof HTMLInputElement && el.type === 'file';
  if (isFile(this)) return this;
  if (isFile(this.control)) return this.control;
  const inside = this.querySelector?.('input[type=file]');
  if (inside) return inside;
  const label = this.closest?.('label');
  if (label && isFile(label.control)) return label.control;
  for (const attr of ['for', 'aria-controls']) {
    const el = this.getAttribute?.(attr) && this.getRootNode().getElementById?.(this.getAttribute(attr));
    if (isFile(el)) return el;
  }
  return null;
}`;

// Failing that, click the target with the file picker caught: most "Choose
// files" buttons call input.click() (or showPicker()) on a hidden input, often
// one made on the spot and never added to the page. The patched methods hand
// back that input instead of opening Chrome's picker, which a CDP click
// couldn't open anyway (no user gesture). Resolves to the input, or to a
// string when the page uses showOpenFilePicker, which no input can fill.
const CLICKED_FILE_INPUT = `function (waitMs) {
  const proto = HTMLInputElement.prototype;
  const { click, showPicker } = proto;
  const openFilePicker = window.showOpenFilePicker;
  let got = null;
  proto.click = function () {
    if (this.type !== 'file') return click.call(this);
    got = this;
  };
  proto.showPicker = function () {
    if (this.type !== 'file') return showPicker.call(this);
    got = this;
  };
  if (openFilePicker) {
    window.showOpenFilePicker = () => {
      got = 'showOpenFilePicker';
      return Promise.reject(new DOMException('The user aborted a request.', 'AbortError'));
    };
  }
  // A click that reaches a file input by dispatch rather than click().
  const onClick = (e) => {
    const el = e.composedPath()[0];
    if (el instanceof HTMLInputElement && el.type === 'file') {
      got ||= el;
      e.preventDefault();
    }
  };
  document.addEventListener('click', onClick, true);
  const restore = () => {
    proto.click = click;
    proto.showPicker = showPicker;
    if (openFilePicker) window.showOpenFilePicker = openFilePicker;
    document.removeEventListener('click', onClick, true);
  };
  try {
    (${SCRIPT_CLICK}).call(this);
  } catch (e) {
    restore();
    throw e;
  }
  // Handlers can be async (a lazy-loaded uploader), so give them a moment.
  return new Promise((resolve) => {
    const until = Date.now() + waitMs;
    const poll = () => {
      if (got || Date.now() > until) {
        restore();
        resolve(got);
      } else setTimeout(poll, 25);
    };
    poll();
  });
}`;

// Last resort: the file input nearest the target in the page.
const NEAREST_FILE_INPUT = `function () {
  for (let el = this.parentElement; el; el = el.parentElement) {
    const input = el.querySelector('input[type=file]');
    if (input) return input;
  }
  return null;
}`;

const isRef = (target) => /^e\d+$/.test(target);

// A ref from a snapshot, or a CSS selector (for a page you've read the
// source of); either way a remote object to work on.
async function targetObject(tabId, target) {
  if (isRef(target)) {
    const { object } = await cdp(tabId, 'DOM.resolveNode', { backendNodeId: await nodeFor(tabId, target) });
    return object.objectId;
  }
  const r = await cdp(tabId, 'Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(target)})` });
  if (r.exceptionDetails) throw new Error(`"${target}" is neither a ref (e12) nor a CSS selector that works: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
  if (!r.result.objectId) throw new Error(`nothing in tab ${tabId} matches the selector "${target}"`);
  return r.result.objectId;
}

const objectResult = (r) => (r.exceptionDetails ? null : r.result);

// The file input behind a target, and a few words on how it was found.
async function fileInputFor(tabId, target) {
  const objectId = await targetObject(tabId, target);
  const call = (functionDeclaration, args = [], extra = {}) =>
    cdp(tabId, 'Runtime.callFunctionOn', { objectId, functionDeclaration, arguments: args, ...extra }).then(objectResult);
  const linked = await call(LINKED_FILE_INPUT);
  if (linked?.objectId) return { objectId: linked.objectId, how: '' };
  const clicked = await call(CLICKED_FILE_INPUT, [{ value: 1500 }], { awaitPromise: true });
  if (clicked?.value === 'showOpenFilePicker') {
    throw new Error(`${target} opens the page's showOpenFilePicker, which takes no files from upload; a real click and the macOS Open sheet (computercub) is the way in`);
  }
  if (clicked?.objectId) return { objectId: clicked.objectId, how: `the file input ${target} opens when clicked` };
  const nearest = await call(NEAREST_FILE_INPUT);
  if (nearest?.objectId) return { objectId: nearest.objectId, how: `the file input nearest ${target}; it opened nothing when clicked, so check this is the right one` };
  throw new Error(`no file input goes with ${target}: it isn't one, has none inside or linked to it, opened none when clicked, and the page has none`);
}

const KEYS = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  PageUp: { code: 'PageUp', keyCode: 33 },
};
const MODS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
// On macOS, Cmd+A and friends sent over CDP don't reach the editor as
// shortcuts (tested on X's composer, 29 Oct); Chrome wants the editing
// command named alongside the key.
const MAC_COMMANDS = { 'Meta+a': 'selectAll', 'Meta+c': 'copy', 'Meta+x': 'cut', 'Meta+v': 'paste', 'Meta+z': 'undo', 'Meta+Shift+z': 'redo' };

// "Enter", "Meta+a", "Shift+Tab"
async function pressKey(tabId, combo) {
  await cdp(tabId, 'Page.enable');
  const parts = combo.split('+');
  const key = parts.pop();
  const modifiers = parts.reduce((m, p) => m | (MODS[p] || 0), 0);
  const k = KEYS[key] || { code: `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0), text: key };
  const ev = { key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers };
  // Text only goes with an unmodified key, or Cmd+A would type an "a".
  const commands = MAC_COMMANDS[combo] ? [MAC_COMMANDS[combo]] : undefined;
  // The editing command only runs on a full keyDown; rawKeyDown ignores it.
  const type = modifiers && !commands ? 'rawKeyDown' : 'keyDown';
  await cdp(tabId, 'Input.dispatchKeyEvent', { ...ev, type, text: modifiers ? undefined : k.text, commands });
  await cdp(tabId, 'Input.dispatchKeyEvent', { ...ev, type: 'keyUp' });
}

async function evaluate(tabId, expression) {
  const r = await cdp(tabId, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

async function waitForReady(tabId, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const ready = await evaluate(tabId, 'document.readyState').catch(() => null);
    if (ready === 'complete') return;
    await new Promise((r) => setTimeout(r, 250));
  }
}

// Sign-in pages are where an agent most often needs you, and where it's
// easiest to forget that its tab is in a window you may not be looking at.
const SIGN_IN = `!!document.querySelector('input[type=password]') || /(log|sign)[-_ ]?(in|on)|auth|sso/i.test(location.hostname + location.pathname)`;

async function handoffHint(tabId) {
  if (!bearTabs.has(tabId)) return '';
  const signIn = await evaluate(tabId, SIGN_IN).catch(() => false);
  return signIn
    ? `\n(this looks like a sign-in page, in BrowserBear's own window, which the user may not be looking at. If they have to sign in: browserbear handoff ${tabId})`
    : '';
}

// Pages match without their #fragment.
const page = (url) => {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
};

// The agent tab (in BrowserBear's window, or already handed over) on a page:
// where it is now, or where an agent sent it, since a sign-in redirect
// leaves it somewhere else (Qantas bookings -> its login page, 30 Oct).
// Only exact pages: the same site would find an unrelated GitHub tab for a
// link to a PR.
async function agentTabFor(url) {
  const want = page(url);
  if (!want) throw new Error(`not a tab id or a URL: ${url}`);
  // Where agents sent tabs is known here, so that's checked without asking
  // Chrome: listing every profile's tabs can take seconds while their
  // extensions wake, and Threadbear is waiting to open the link.
  for (const [tabId, pages] of sentTo) if (pages.has(want) && profiles.has(tabOwner.get(tabId))) return tabId;
  const lists = await Promise.all(
    [...profiles.values()].map((p) => call(p, 'tabs').then((tabs) => tabs.map((t) => remember(p.instance, t)), () => [])),
  );
  const hit = lists.flat().find((t) => (t.agent || bearTabs.has(t.tabId)) && page(t.url) === want);
  if (!hit) throw new Error(`no agent tab is open on ${url}`);
  return hit.tabId;
}

function sent(tabId, url) {
  if (!sentTo.has(tabId)) sentTo.set(tabId, new Set());
  sentTo.get(tabId).add(page(url));
}

const remember = (instance, tab) => {
  tabOwner.set(tab.tabId, instance);
  return tab;
};

const commands = {
  async status() {
    return { pid: process.pid, socket: SOCKET, profiles: [...profiles.values()].map(describe) };
  },

  async profiles() {
    const connected = [...profiles.values()];
    return chromeProfiles().map((p) => {
      const c = connected.find((x) => x.email && x.email === p.email);
      return `${c ? '●' : '○'} ${p.name} (${p.email || 'not signed in'}, ${p.dir})${c ? '' : ': extension not connected'}`;
    }).join('\n');
  },

  async tabs({ profile }) {
    const list = profile ? [findProfile(profile)] : [...profiles.values()];
    const out = [];
    for (const p of list) {
      out.push(`${describe(p)}:`);
      for (const t of await call(p, 'tabs')) {
        remember(p.instance, t);
        out.push(`  ${t.tabId}${t.active ? '*' : ' '} ${t.title.slice(0, 60)} <${t.url.slice(0, 100)}>${marks.label(t.tabId)}`);
      }
    }
    return out.join('\n');
  },

  async open({ profile, url, thread }) {
    const p = findProfile(profile);
    const tab = remember(p.instance, await call(p, 'open', { url }, 40_000));
    marks.used(tab.tabId, thread, `opening ${hostOf(url)}`);
    bearTabs.add(tab.tabId);
    sent(tab.tabId, url);
    const snap = await snapshot(tab.tabId);
    return `opened tab ${tab.tabId} in ${describe(p)}, in BrowserBear's own window\n${snap}${await handoffHint(tab.tabId)}`;
  },

  // Find one of Mike's own tabs by a bit of its URL or title.
  async claim({ match, profile, thread }) {
    const list = profile ? [findProfile(profile)] : [...profiles.values()];
    const hits = [];
    for (const p of list) {
      for (const t of await call(p, 'tabs')) {
        remember(p.instance, t);
        if (`${t.url} ${t.title}`.toLowerCase().includes(match.toLowerCase())) hits.push({ p, t });
      }
    }
    if (!hits.length) throw new Error(`no open tab matches "${match}"`);
    if (hits.length > 1) {
      return `several tabs match; pick one by id:\n${hits.map(({ p, t }) => `  ${t.tabId} [${describe(p)}] ${t.title.slice(0, 60)} <${t.url.slice(0, 100)}>`).join('\n')}`;
    }
    marks.used(hits[0].t.tabId, thread, 'looking at the page');
    return snapshot(hits[0].t.tabId);
  },

  snap: ({ tab, full }) => snapshot(tab, { full }),

  async click({ tab, ref, script }) {
    const node = await nodeFor(tab, ref);
    const before = state(tab).last;
    await markPage(tab);
    const note = await clickNode(tab, node, { script });
    await settleAfterAction(tab);
    let out = await snapshot(tab);
    const unchanged = !script && sameApartFromFocus(before, state(tab).last);
    // A link that ignored a real click but takes a script one (BTC Markets'
    // "SELL BTC", 30 Oct). Following a link twice is harmless, so it's just
    // done; anything else might be a toggle, so that's left to the agent.
    if (unchanged && !note && (await isLink(tab, node).catch(() => false))) {
      await markPage(tab);
      await scriptClick(tab, node);
      await settleAfterAction(tab);
      return `(the real click on that link changed nothing, so it was clicked again by script)\n${await snapshot(tab)}`;
    }
    // A click that changed nothing visible is often one the page ignored.
    if (unchanged) out += `\n(if that click should have done something: browserbear click ${tab} ${ref} --script)`;
    return (note ? note + '\n' : '') + out;
  },

  async type({ tab, ref, text, submit, replace }) {
    if (ref) {
      const node = await nodeFor(tab, ref);
      await cdp(tab, 'DOM.focus', { backendNodeId: node }).catch(() => clickNode(tab, node));
    }
    if (replace) {
      await pressKey(tab, 'Meta+a');
      await pressKey(tab, 'Backspace');
    }
    // insertText fires the same beforeinput/input events as real typing, which
    // rich editors (Discord, Slack, Studio) listen for; setting .value doesn't.
    await cdp(tab, 'Input.insertText', { text });
    if (submit) {
      await markPage(tab);
      await pressKey(tab, 'Enter');
      await settleAfterAction(tab);
    } else await settle();
    return snapshot(tab);
  },

  async key({ tab, key }) {
    await markPage(tab);
    await pressKey(tab, key);
    await settleAfterAction(tab);
    return snapshot(tab);
  },

  async goto({ tab, url }) {
    // Page events (the leave-site dialog among them) only arrive once enabled.
    await cdp(tab, 'Page.enable');
    await cdp(tab, 'Page.navigate', { url });
    sent(tab, url);
    await waitForReady(tab);
    return (await snapshot(tab)) + (await handoffHint(tab));
  },

  // The page's text, for reading rather than acting. Long pages go to a file.
  async read({ tab, max = 4000 }) {
    // Straight after a click that navigates, there may be no body yet, or no
    // page to evaluate in at all (passport.service.gov.uk, 30 Oct): wait for
    // one rather than fail.
    await waitForReady(tab, 10_000);
    let text = null;
    for (let i = 0; i < 20 && typeof text !== 'string'; i++) {
      if (i) await sleep(250);
      text = await evaluate(tab, 'document.body?.innerText ?? null').catch(() => null);
    }
    if (typeof text !== 'string') throw new Error(`tab ${tab} has no page to read yet; try again in a moment`);
    if (text.length <= max) return text;
    const file = path.join(OUT, `tab-${tab}-${Date.now()}.txt`);
    fs.writeFileSync(file, text, { mode: 0o600 });
    return `${text.slice(0, max)}\n… ${text.length - max} more characters in ${file}`;
  },

  async shot({ tab, file }) {
    const { data } = await cdp(tab, 'Page.captureScreenshot', { format: 'png' });
    file ||= path.join(OUT, `tab-${tab}-${Date.now()}.png`);
    fs.writeFileSync(file, Buffer.from(data, 'base64'), { mode: 0o600 });
    return file;
  },

  eval: ({ tab, js }) => evaluate(tab, js),

  // Raw CDP, for debugging BrowserBear itself and for anything it doesn't wrap yet.
  cdp: ({ tab, method, params }) => cdp(tab, method, params ? JSON.parse(params) : {}),

  async upload({ tab, ref, files }) {
    if (!files?.length) throw new Error('say which files to upload');
    const paths = files.map((f) => path.resolve(f));
    const missing = paths.filter((f) => !fs.existsSync(f));
    if (missing.length) throw new Error(`no such file: ${missing.join(', ')}`);
    const { objectId, how } = await fileInputFor(tab, ref);
    // Fires the input and change events a real pick would.
    await cdp(tab, 'DOM.setFileInputFiles', { objectId, files: paths });
    await settle();
    const note = `(${paths.length === 1 ? path.basename(paths[0]) : `${paths.length} files`} set on ${how || (isRef(ref) ? ref : `"${ref}"`)})`;
    return `${note}\n${await snapshot(tab)}`;
  },

  async download({ tab, url, filename }) {
    const p = await ownerOf(tab);
    return call(p, 'download', { url, filename }, 130_000);
  },

  async dialog({ tab, action, text }) {
    await cdp(tab, 'Page.handleJavaScriptDialog', { accept: action !== 'dismiss', promptText: text });
    state(tab).dialog = null;
    await settle();
    return snapshot(tab);
  },

  async show({ tab }) {
    await call(await ownerOf(tab), 'show', { tabId: tab });
    if (!bearTabs.has(tab)) return `tab ${tab} is at the front of its window`;
    return `tab ${tab} is at the front of BrowserBear's window, which the user may not be looking at. To have them do something in it: browserbear handoff ${tab}`;
  },

  // Gives a tab to the user: an agent's tab moves from BrowserBear's window
  // into theirs, and either way it comes to the front and Chrome is focused.
  // Given a URL rather than an id, it finds the agent tab already on that
  // page (Threadbear does this for the link buttons on an agent's asks, so
  // you don't get a second tab of the same page).
  async handoff({ tab, thread }) {
    const tabId = typeof tab === 'number' ? tab : await agentTabFor(tab);
    const p = await ownerOf(tabId);
    const t = await call(p, 'handoff', { tabId }).catch((e) => {
      if (/unknown op/.test(e.message)) throw new Error(`${describe(p)} has an older BrowserBear extension; browserbear reload, then try again`);
      // You closed the tab an agent had sent there: forget it, look again.
      if (typeof tab === 'string' && /no tab with id/i.test(e.message) && sentTo.delete(tabId)) return null;
      throw e;
    });
    if (!t) return commands.handoff({ tab, thread });
    marks.handedOff(tabId, thread);
    // It's the user's now: no more pulling it forward for real clicks.
    bearTabs.delete(tabId);
    return `tab ${tabId} is in front of the user, in their own Chrome window: ${t.title} <${t.url}>\nSay so when you ask them; a link to the same page as well would open a second tab.`;
  },

  // After changing the extension's files: reloads it in every connected
  // profile (unpacked installs don't notice changes by themselves).
  async reload() {
    const names = [];
    for (const p of profiles.values()) {
      await call(p, 'reload').catch(() => {});
      names.push(describe(p));
    }
    return `reloading BrowserBear in ${names.join(', ') || 'no profiles'}`;
  },

  // Focusing an agent's tab in BrowserBear's window would bring that window
  // forward wherever it is, which is the handoff problem again; so focus is
  // handoff, and for your own tabs that just brings them to the front.
  focus: (args) => commands.handoff(args),

  async close({ tab }) {
    const p = await ownerOf(tab);
    await call(p, 'close', { tabId: tab });
    tabState.delete(tab);
    marks.closed(tab);
    tabOwner.delete(tab);
    bearTabs.delete(tab);
    sentTo.delete(tab);
    return `closed tab ${tab}`;
  },
};

function onHostMessage(profile, msg) {
  if (msg.type === 'event') {
    if (msg.event === 'dialog') {
      state(msg.tabId).dialog = msg.params;
      // Whatever was waiting on that tab (a navigation, a click) is stuck
      // behind the dialog; say so now rather than after a 20 s timeout.
      for (const [id, w] of profile.pending) {
        if (w.tabId !== msg.tabId) continue;
        profile.pending.delete(id);
        clearTimeout(w.timer);
        w.reject(new Error(dialogLine(msg.tabId, msg.params)));
      }
    }
    if (msg.event === 'dialogClosed') state(msg.tabId).dialog = null; // you answered it yourself
    if (msg.event === 'detached') log('detached', msg.tabId, msg.reason);
    // The buttons on the pill in an agent's tab.
    if (msg.event === 'mark' && msg.action === 'stop') marks.stop(msg.tabId);
    if (msg.event === 'mark' && msg.action === 'release') marks.release(msg.tabId);
    return;
  }
  const waiter = profile.pending.get(msg.id);
  if (!waiter) return;
  profile.pending.delete(msg.id);
  clearTimeout(waiter.timer);
  if (msg.ok) waiter.resolve(msg.result);
  else waiter.reject(new Error(msg.error));
}

let busy = 0; // client commands in flight, so a restart waits for them

// Just after a (re)start the hosts haven't said hello yet; give them a moment
// rather than answer "none connected".
const startedAt = Date.now();
async function hostsReady() {
  if (Date.now() - startedAt > 5_000) return;
  while (!profiles.size && Date.now() - startedAt < 5_000) await sleep(100);
  // Each profile's host reconnects on its own clock; let the rest catch up.
  await sleep(Math.max(0, 1_000 - (Date.now() - startedAt)));
}

async function onClientMessage(conn, msg) {
  const fn = commands[msg.cmd];
  let using = null; // the tab this command works in, for its marks
  busy++;
  try {
    if (!fn) throw new Error(`unknown command ${msg.cmd}`);
    if (msg.cmd !== 'status') await hostsReady();
    const args = { ...(msg.args || {}), thread: msg.thread };
    // Left as text when it isn't a number: handoff also takes a URL.
    if (/^\d+$/.test(String(args.tab))) args.tab = Number(args.tab);
    if (typeof args.tab === 'number' && USES[msg.cmd]) {
      using = args.tab;
      marks.begin(using, msg.thread, USES[msg.cmd](args));
    }
    conn.write(line({ id: msg.id, ok: true, result: await fn(args) }));
  } catch (e) {
    conn.write(line({ id: msg.id, ok: false, error: e.message }));
  } finally {
    busy--;
    if (using !== null) marks.end(using);
  }
}

const server = net.createServer((conn) => {
  let role = null; // 'host' | 'client'
  let profile = null;
  conn.on(
    'data',
    lineReader((msg) => {
      if (msg.type === 'hello') {
        role = 'host';
        const known = chromeProfiles().find((p) => p.email && p.email === msg.email) || {};
        const old = profiles.get(msg.instance);
        // Same profile reconnecting: keep pending calls' bookkeeping fresh.
        if (old && old.conn !== conn) old.conn.destroy();
        profile = { instance: msg.instance, email: msg.email, name: known.name, dir: known.dir, conn, pending: new Map() };
        profiles.set(msg.instance, profile);
        log('hello from', describe(profile), msg.version);
        marks.resend();
        // The name agents will find this profile by, for the setup page.
        // Older extensions answer it with an "unknown op" error that has no
        // id, which onHostMessage drops.
        conn.write(line({ type: 'welcome', name: profile.name || null, email: profile.email || null, dir: profile.dir || null }));
        return;
      }
      if (role === 'host') return onHostMessage(profile, msg);
      role = 'client';
      onClientMessage(conn, msg);
    }),
  );
  conn.on('error', () => {});
  conn.on('close', () => {
    if (role === 'host' && profiles.get(profile?.instance)?.conn === conn) {
      for (const w of profile.pending.values()) {
        clearTimeout(w.timer);
        w.reject(new Error(`${describe(profile)} disconnected`));
      }
      profiles.delete(profile.instance);
      log('gone', describe(profile));
    }
  });
});

// Only one service: if the socket answers, someone else already is it.
function listen() {
  server.listen(SOCKET, () => {
    fs.chmodSync(SOCKET, 0o600);
    log('listening', SOCKET, 'pid', process.pid);
    watch(fs.statSync(SOCKET).ino);
  });
}

// The service runs until the Mac restarts, so it would go on running the code
// it started with: an agent hit an upload bug for ten minutes after the fix
// was on disk (30 Oct). So it bows out when its code changes, once nothing
// is in flight, and the hosts (and the CLI) start a fresh one. Refs from
// earlier snapshots go with it; a new snap brings them back. It also goes when
// its socket does (the tests' throwaway homes), rather than linger unreachable.
const CODE_DIR = path.dirname(fileURLToPath(import.meta.url));
function codeStamp() {
  try {
    return fs.readdirSync(CODE_DIR).filter((f) => f.endsWith('.mjs')).map((f) => `${f}:${fs.statSync(path.join(CODE_DIR, f)).mtimeMs}`).join(',');
  } catch {
    return null; // mid-save; look again next time
  }
}

function watch(ino) {
  const code = codeStamp();
  setInterval(() => {
    const now = fs.statSync(SOCKET, { throwIfNoEntry: false });
    if (now?.ino !== ino) {
      log('socket gone; exiting');
      process.exit(0);
    }
    const stamp = codeStamp();
    if (busy || !stamp || stamp === code) return;
    log('code changed; exiting so a fresh service starts');
    fs.rmSync(SOCKET, { force: true });
    process.exit(0);
  }, 2_000).unref();
}
server.on('error', (e) => {
  if (e.code !== 'EADDRINUSE') throw e;
  const probe = net.createConnection(SOCKET);
  probe.on('connect', () => {
    log('another service is running; exiting');
    process.exit(0);
  });
  probe.on('error', () => {
    fs.rmSync(SOCKET, { force: true }); // stale socket from a crash
    listen();
  });
});

fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
listen();
