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
import { HOME, LOGS, OUT, SOCKET, line, lineReader } from './wire.mjs';
import { RefMap, compact, diff } from './snapshot.mjs';

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
      reject(new Error(`${op} timed out after ${timeoutMs / 1000}s in ${describe(profile)}`));
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

const state = (tabId) => {
  if (!tabState.has(tabId)) tabState.set(tabId, { refs: new RefMap(), last: null, dialog: null });
  return tabState.get(tabId);
};

async function cdp(tabId, method, params, timeoutMs = 20_000) {
  return call(await ownerOf(tabId), 'cdp', { tabId, method, params }, timeoutMs);
}

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

async function snapshot(tabId, { full = false } = {}) {
  const s = state(tabId);
  // A JS dialog freezes the page, so every other call would just time out.
  if (s.dialog) return `tab ${tabId}\n${dialogLine(tabId, s.dialog)}`;
  await cdp(tabId, 'Page.enable');
  const { nodes } = await cdp(tabId, 'Accessibility.getFullAXTree');
  const lines = compact(nodes, s.refs);
  const out = full ? { full: true, text: lines.join('\n') } : diff(s.last, lines);
  s.last = lines;
  const tab = (await call(await ownerOf(tabId), 'tabs')).find((t) => t.tabId === tabId);
  const head = `tab ${tabId}: ${tab?.title || ''} <${tab?.url || ''}>`;
  return `${head}\n${out.text}`;
}

const settle = () => new Promise((r) => setTimeout(r, SETTLE_MS));

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
        out.push(`  ${t.tabId}${t.active ? '*' : ' '} ${t.title.slice(0, 60)} <${t.url.slice(0, 100)}>`);
      }
    }
    return out.join('\n');
  },

  async open({ profile, url, group }) {
    const p = findProfile(profile);
    const tab = remember(p.instance, await call(p, 'open', { url, group }, 40_000));
    bearTabs.add(tab.tabId);
    return `opened tab ${tab.tabId} in ${describe(p)}\n${await snapshot(tab.tabId)}`;
  },

  // Find one of Mike's own tabs by a bit of its URL or title.
  async claim({ match, profile }) {
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
    return snapshot(hits[0].t.tabId);
  },

  snap: ({ tab, full }) => snapshot(tab, { full }),

  async click({ tab, ref, script }) {
    const note = await clickNode(tab, await nodeFor(tab, ref), { script });
    await settle();
    let out = await snapshot(tab);
    // A click that changed nothing visible is often one the page ignored.
    if (out.endsWith('(no change)') && !script) out += `\n(if that click should have done something: browserbear click ${tab} ${ref} --script)`;
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
    if (submit) await pressKey(tab, 'Enter');
    await settle();
    return snapshot(tab);
  },

  async key({ tab, key }) {
    await pressKey(tab, key);
    await settle();
    return snapshot(tab);
  },

  async goto({ tab, url }) {
    // Page events (the leave-site dialog among them) only arrive once enabled.
    await cdp(tab, 'Page.enable');
    await cdp(tab, 'Page.navigate', { url });
    await waitForReady(tab);
    return snapshot(tab);
  },

  // The page's text, for reading rather than acting. Long pages go to a file.
  async read({ tab, max = 4000 }) {
    const text = await evaluate(tab, 'document.body.innerText');
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
    const backendNodeId = await nodeFor(tab, ref);
    await cdp(tab, 'DOM.setFileInputFiles', { backendNodeId, files: files.map((f) => path.resolve(f)) });
    await settle();
    return snapshot(tab);
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
    return `tab ${tab} is at the front of its window`;
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

  async focus({ tab }) {
    const p = await ownerOf(tab);
    await call(p, 'focus', { tabId: tab });
    return `tab ${tab} is in front`;
  },

  async close({ tab }) {
    const p = await ownerOf(tab);
    await call(p, 'close', { tabId: tab });
    tabState.delete(tab);
    tabOwner.delete(tab);
    bearTabs.delete(tab);
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
    return;
  }
  const waiter = profile.pending.get(msg.id);
  if (!waiter) return;
  profile.pending.delete(msg.id);
  clearTimeout(waiter.timer);
  if (msg.ok) waiter.resolve(msg.result);
  else waiter.reject(new Error(msg.error));
}

async function onClientMessage(conn, msg) {
  const fn = commands[msg.cmd];
  try {
    if (!fn) throw new Error(`unknown command ${msg.cmd}`);
    const args = { ...(msg.args || {}) };
    if (args.tab !== undefined) args.tab = Number(args.tab);
    conn.write(line({ id: msg.id, ok: true, result: await fn(args) }));
  } catch (e) {
    conn.write(line({ id: msg.id, ok: false, error: e.message }));
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
  });
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
