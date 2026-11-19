// The BrowserBear service: one per Mac, on a Unix socket. Native hosts (one per
// Chrome profile with the extension) and clients (the CLI, Threadbear) both
// connect here. Hosts say hello first; anything else is a client sending
// { id, cmd, args } and getting back { id, ok, result | error }.
//
// The page logic lives here rather than in the extension, so changing how
// snapshots or clicks work never needs a new extension release.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME, LOGS, OUT, SOCKET, line, lineReader } from './wire.mjs';
import { createMarks } from './marks.mjs';
import { domainOf, looksLikeEmail, menuProfiles, openByEmail, openByMenu } from './chrome.mjs';
import { RefMap, compact, diff, sameApartFromFocus } from './snapshot.mjs';
import { createPanel } from './panel.mjs';
import { allowedFor, loginsFor, pickLogin, secretsFor } from './onepassword.mjs';
import { tbPath, showBrowserPanel } from './threadbear.mjs';

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
// The user's own tabs an agent has been let into, with claim or --user-tab.
const claimed = new Set();
// Tabs handed to the user that they haven't finished with. Kept here as well
// as by the extension, because a tab handed over in Threadbear's Browser panel,
// or in a profile with no other window to move it to, or a popup, stays where
// it was, so its window doesn't say it's the user's now. On disk, so a service
// restart mid sign-in doesn't make them closable again.
const HANDED = path.join(HOME, 'handed.json');
// Agent-only (Mike's trial, 6 Nov 2026; see keepToAgentChrome): up here
// because ownerOf and remember check it.
const AGENT_ONLY = path.join(HOME, 'agent-only');
const AGENT_INSTANCE = 'agent-chrome';
// Opt-in: handoffs of the user's own tabs go to Threadbear's Browser panel.
function agentOnlyOn() {
  return fs.existsSync(AGENT_ONLY);
}
const handed = new Set((() => {
  try { return JSON.parse(fs.readFileSync(HANDED, 'utf8')); } catch { return []; }
})());
const setHanded = (tabId, on) => {
  if (handed.has(tabId) === on) return;
  on ? handed.add(tabId) : handed.delete(tabId);
  try { fs.writeFileSync(HANDED, JSON.stringify([...handed]), { mode: 0o600 }); } catch (e) { log('cannot save handoffs:', e.message); }
};
// Popups the Browser panel saw an agent's page open, in windows of their own.
let nextId = 1;

// Chrome's own list of profiles, so "Work" or "Profile 2" or the email
// all find the same one. Read fresh each time: profiles come and go. Null when
// it can't be read: macOS refuses this file to other apps (EPERM on Mike's Mac,
// 31 Oct, even for a service Chrome started), and extensions can only learn a
// profile's email, so then the email is the only name a profile has.
function chromeProfiles() {
  try {
    const cache = JSON.parse(fs.readFileSync(LOCAL_STATE, 'utf8')).profile?.info_cache || {};
    return Object.entries(cache).map(([dir, p]) => ({ dir, name: p.name, email: p.user_name || null }));
  } catch (e) {
    log('cannot read Chrome profiles:', e.message);
    return null;
  }
}

const NO_NAMES = "BrowserBear can't read Chrome's list of profiles (macOS may be blocking it), so names and folders like \"Default\" won't work here; use the email";

function describe(p) {
  return p.name ? `${p.name}${p.email ? ` (${p.email})` : ''}` : p.email || p.instance.slice(0, 8);
}

// Names from Chrome's Profiles menu that BrowserBear has matched to a
// connected profile's email, so a profile keeps its name when it reconnects.
const menuNames = new Map(); // email -> "Michael (convex.dev)"

function setMenuName(p, name) {
  p.menuName = name;
  p.name ||= name; // Local State's name, where there is one, stays the display name
  if (p.email) menuNames.set(p.email, name);
}

// Give connected profiles their names from the Profiles menu, where the menu
// says which one it is. The menu has names but no emails, so it takes working out:
//  - the name it already has from Chrome's list, or
//  - a name with the email's domain in brackets, and only one such name, or
//  - a personal account: Chrome only brackets a work account's domain, so a
//    profile left with no name must be a name without brackets. Only when
//    there's exactly one of each. Without this "Michael" (Mike's Gmail) stays
//    unmatched, and looks like a profile that still needs opening.
function learnNames(menu) {
  const unmatched = () => [...profiles.values()].filter((p) => p.email && !p.menuName);
  for (const p of unmatched()) {
    const domain = p.email.split('@')[1].toLowerCase();
    const byDomain = menu.filter((n) => domainOf(n) === domain);
    if (p.name && menu.includes(p.name)) setMenuName(p, p.name);
    else if (byDomain.length === 1) setMenuName(p, byDomain[0]);
  }
  const left = unmatched();
  const taken = new Set([...profiles.values()].map((p) => p.menuName));
  const plain = menu.filter((n) => !domainOf(n) && !taken.has(n));
  if (left.length === 1 && plain.length === 1) setMenuName(left[0], plain[0]);
}

// Chrome's list says who a connected profile is whenever it can be read, which
// may not have been when the profile connected.
function learnFromChrome(known) {
  for (const p of profiles.values()) {
    const k = known?.find((x) => x.email && x.email.toLowerCase() === p.email?.toLowerCase());
    if (k) Object.assign(p, { name: p.name && p.name !== p.menuName ? p.name : k.name, dir: k.dir });
  }
}

const quoted = (names) => names.map((n) => `"${n}"`).join(', ');

// A profile is asked for by its whole name, email or folder, in any case. Never
// by part of one: "Michael" once found "Michael (convex.dev)" because the
// profile really called Michael had no name yet, and an agent ended up signed
// in as the wrong person (James interview, 3 Nov). Being sent back to say it
// properly costs one try; the wrong account can cost a lot more.
// Also by the "Name (email)" BrowserBear itself prints in its lists and errors,
// since agents copy that back (5 Nov: "Michael (mike.cann@gmail.com)" was
// refused by the very error that listed it). It's still the whole of one.
const printed = (p) => (p.name && p.email ? `${p.name} (${p.email})` : null);
const isCalled = (p, w) => [p.name, p.menuName, p.email, p.dir, printed(p)].some((v) => v?.toLowerCase() === w);
const nearly = (names, w) => names.filter((n) => n?.toLowerCase().includes(w));

async function findProfile(want) {
  if (profiles.has(want)) return profiles.get(want);
  // The agent's own Chrome: started when it's first asked for (agent/agent-host.mjs).
  if (String(want).toLowerCase() === 'agent' && !profiles.has('agent-chrome')) await startAgentChrome();
  const all = [...profiles.values()];
  if (!want) {
    if (all.length === 1) return all[0];
    throw new Error(`say which profile: ${all.map(describe).join(', ') || 'none connected'}`);
  }
  const w = want.toLowerCase();
  const connected = () => [...profiles.values()];
  const find = () => {
    const hits = connected().filter((p) => isCalled(p, w));
    // Chrome lets two profiles share a name.
    if (hits.length > 1) throw new Error(`"${want}" could be any of ${hits.map(describe).join(', ')}; use the email`);
    return hits[0];
  };
  let hit = find();
  if (hit) return hit;
  const known = chromeProfiles();
  learnFromChrome(known);
  if ((hit = find())) return hit;
  // Not connected: most likely Chrome has no window open for it, so its
  // extension isn't running. Open it, rather than send the agent off to do it
  // (Title lab, 2 Nov: a Codex agent gave up here).
  const menu = await menuProfiles();
  if (Array.isArray(menu)) {
    learnNames(menu);
    if ((hit = find())) return hit;
  }
  const names = Array.isArray(menu) ? menu : [];
  const named = names.find((n) => n.toLowerCase() === w);
  // Where Chrome's list can be read, it has the email even for a name.
  const listed = known?.filter((p) => isCalled(p, w)) || [];
  if (listed.length > 1) throw new Error(`"${want}" could be any of ${listed.map((p) => `${p.name} (${p.email || 'not signed in'}, ${p.dir})`).join(', ')}; use the email`);
  const email = looksLikeEmail(want) ? want : listed[0]?.email || null;
  const fail = (reason) => {
    const how = named
      ? `computercub menu "Google Chrome" "Profiles > ${named}"`
      : `open -na "Google Chrome" --args --profile-email=${email || '<its email>'}`;
    const inMenu = names.length ? `; Chrome's Profiles menu has ${quoted(names)}` : '';
    return new Error(
      `no connected profile matches "${want}"; connected: ${all.map(describe).join(', ') || 'none'}${inMenu}. ${reason}. ` +
        `Open a window for it (${how}), then try again${known || named ? '' : `. ${NO_NAMES}`}`,
    );
  };
  if (!named && !email) {
    const near = [...new Set(nearly([...connected().flatMap((p) => [p.name, p.menuName, p.email]), ...names, ...(known || []).flatMap((p) => [p.name, p.email])], w))];
    if (near.length) throw new Error(`no profile is called "${want}"; it has to be the whole name, email or folder. Did you mean ${quoted(near)}?`);
    throw fail(Array.isArray(menu) ? (names.length ? "it isn't in Chrome's Profiles menu" : "Chrome isn't running") : `BrowserBear couldn't read Chrome's Profiles menu (${menu.error})`);
  }
  // Opened a moment ago and nothing connected: another window won't help.
  const key = email || named;
  if (Date.now() - (noBear.get(key) || 0) < NO_BEAR_MS) {
    throw fail(`BrowserBear opened it a few minutes ago and its extension never connected, so it's probably not installed in that profile; it won't open another window for it until ${NO_BEAR_MS / 60_000} minutes have passed`);
  }
  if (!opening.has(w)) {
    const before = new Set(profiles.keys());
    opening.set(w, (async () => {
      try {
        if (email) await openByEmail(email);
        else await openByMenu(named);
      } catch (e) {
        throw fail(`BrowserBear couldn't open it (${e.message})`);
      }
      log('opened Chrome profile', want);
      // Its extension says hello once the window is up, usually within a second
      // or two. From the menu, the name is only known from what turns up new.
      const deadline = Date.now() + OPEN_WAIT_MS;
      while (Date.now() < deadline) {
        const fresh = connected().filter((p) => !before.has(p.instance));
        const p = email ? fresh.find((x) => x.email?.toLowerCase() === email.toLowerCase()) : fresh.length === 1 ? fresh[0] : null;
        if (p) {
          if (named) setMenuName(p, named);
          learnNames(names); // opened by email: the menu may say its name
          return p;
        }
        await sleep(200);
      }
      noBear.set(key, Date.now());
      // From the menu it may be a profile that's connected already, under an
      // email the menu's name couldn't be matched to: nothing new would connect.
      const unnamed = connected().filter((p) => p.email && !p.menuName).map((p) => p.email);
      throw fail(
        email
          ? `BrowserBear asked Chrome to open the profile signed in as ${email}, but nothing new connected in ${OPEN_WAIT_MS / 1000}s (no such profile, or BrowserBear isn't installed in it)`
          : `BrowserBear opened "${named}" from Chrome's Profiles menu, but its extension didn't connect in ${OPEN_WAIT_MS / 1000}s (is BrowserBear installed in it?${unnamed.length ? ` Or it may be one of ${unnamed.join(', ')}, already connected: use the email` : ''})`,
      );
    })().finally(() => opening.delete(w)));
  }
  return opening.get(w);
}

let agentChrome = null;
function startAgentChrome() {
  agentChrome ||= (async () => {
    const host = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'agent', 'agent-host.mjs');
    spawn(process.execPath, [host], { detached: true, stdio: 'ignore', cwd: HOME }).unref();
    // 40 s: the host may first have to end a browser that updated itself
    // underneath it and won't quit, then start it again (agent/agent-host.mjs).
    for (let i = 0; i < 400 && !profiles.has('agent-chrome'); i++) await sleep(100);
    agentChrome = null;
    if (!profiles.has('agent-chrome')) throw new Error("the agent's Chrome didn't start; see agent/host.log in BrowserBear's folder");
  })();
  return agentChrome;
}

const opening = new Map(); // what was asked for -> the profile it's opening
const OPEN_OP_MS = 100_000;
const OPEN_WAIT_MS = Number(process.env.BROWSERBEAR_OPEN_WAIT_MS) || 20_000;
const noBear = new Map(); // email or menu name -> when it was opened and nothing connected
const NO_BEAR_MS = 10 * 60_000;

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
  // Agent-only: the agent's Chrome or nothing, for every command and every
  // CDP call, so a tab id that's also one of Mike's (the agent's start at
  // 1001) can't end up in his profile (Codex review, 6 Nov).
  if (agentOnlyOn()) {
    const agent = profiles.get(AGENT_INSTANCE);
    if (agent && (tabOwner.get(tabId) === AGENT_INSTANCE || (await call(agent, 'tabs')).some((t) => t.tabId === tabId))) {
      tabOwner.set(tabId, AGENT_INSTANCE);
      return agent;
    }
    throw agentOnlyRefusal(`it won't work in tab ${tabId}, which isn't in the agent's Chrome`);
  }
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

// Whose a tab is: 'agent' when an agent opened it and still has it (it's in
// BrowserBear's window, or the agent's own Chrome), 'handed' when an agent
// opened it and handed it to the user, 'claimed' for one of the user's own an
// agent has been let into, 'user' for the rest. null when the extension is too
// old to say. On 5 Nov an agent grepped `tabs` for the page it had just opened,
// got Mike's own tab on the same page (he was replying to his launch post in
// it), and closed it. The extension already knew which was which.
async function whose(tabId) {
  const p = await ownerOf(tabId);
  const tabs = await call(p, 'tabs');
  const t = tabs.find((x) => x.tabId === tabId);
  if (!t) throw Object.assign(new Error(closedMessage(tabId)), { closed: true });
  if (handed.has(tabId)) return { who: 'handed', t, p };
  if (t.agent === undefined) return { who: bearTabs.has(tabId) ? 'agent' : null, t, p };
  if (t.bear !== false) {
    // Relearnt here, as a restarted service starts knowing none, so a tab
    // dragged out later can still be told apart from one no agent opened.
    if (t.bear) bearTabs.add(tabId);
    return { who: 'agent', t, p };
  }
  if (t.agent) return { who: 'handed', t, p };
  if (claimed.has(tabId)) return { who: 'claimed', t, p };
  // A popup an agent's page opened (a Google sign-in, say) is in a window of
  // its own, not BrowserBear's, but it's still the agent's to finish.
  for (let at = t, i = 0; at?.openerTabId != null && i < 5; i++) {
    at = tabs.find((x) => x.tabId === at.openerTabId);
    if (at && at.bear && !handed.has(at.tabId)) return { who: 'agent', t, p };
  }
  // One an agent opened in BrowserBear's window that isn't there now, without
  // a handoff: the user dragged it into a window of their own, so it's theirs,
  // but the refusal mustn't say no agent ever opened it.
  return { who: 'user', left: bearTabs.has(tabId), t, p };
}

// Commands that change a page. Looking (snap, read, shot, eval, show) stays
// open on any tab, unmarked on the user's own; these need the tab to be an
// agent's, or the user's tab to have been lent with claim or --user-tab.
const ACTS = new Set(['click', 'hover', 'type', 'key', 'goto', 'upload', 'dialog', 'cdp', 'fill']);
const NOT_YOURS = "If you meant a tab you opened, use the id browserbear open printed (open --id prints only that), not a match from browserbear tabs.";

function refuseUserTab(cmd, tabId, { who, left, t }) {
  const page = `"${redact(t.title).slice(0, 60)}" <${redact(t.url).slice(0, 100)}>`;
  if (left) {
    return new Error(
      `tab ${tabId} (${page}) was opened by an agent, but it has left BrowserBear's window without a handoff (the user may have dragged it into one of their own windows), so it counts as theirs now and BrowserBear won't ${cmd} ${cmd === 'close' ? 'it' : 'in it'}. snap, read, shot and eval can still look at it. ` +
        `If the user hasn't taken it over and you should carry on in it: browserbear claim ${tabId}${cmd === 'close' ? `, or browserbear close ${tabId} --user-tab` : ', or add --user-tab'}`,
    );
  }
  if (cmd === 'close') {
    const whose = who === 'handed'
      ? "one an agent handed to the user, so it's theirs now"
      : who === null
        ? "one BrowserBear can't place (this profile's extension is too old to say who opened it), so it counts as the user's"
        : "the user's own, not one an agent opened";
    return new Error(
      `tab ${tabId} is ${whose} (${page}), so BrowserBear won't close it: they may be in the middle of something there. ${NOT_YOURS} ` +
        `If the user asked you to close this one: browserbear close ${tabId} --user-tab`,
    );
  }
  return new Error(
    `tab ${tabId} is the user's own (${page}), not one an agent opened, so BrowserBear won't ${cmd} in it. snap, read, shot and eval can still look at it. ${NOT_YOURS} ` +
      `If the user wants you working in this tab: browserbear claim ${tabId}, or add --user-tab`,
  );
}

const closedMessage = (tabId) => `tab ${tabId} has closed, so there's nothing left to act on. browserbear tabs lists what's open`;

// The tab as its profile sees it right now: null if it has gone, undefined if
// that can't be told (the profile's reconnecting, say).
async function tabNow(tabId) {
  const p = profiles.get(tabOwner.get(tabId));
  const tabs = p && (await call(p, 'tabs').catch(() => null));
  return tabs ? (tabs.find((t) => t.tabId === tabId) ?? null) : undefined;
}

const marks = createMarks({
  send: async (tabId, mark) => call(await ownerOf(tabId), 'mark', { tabId, mark }, 5_000),
  log,
});

// beforeStill: the panel's stills keep the debugger on a tab, so one an agent
// woke and the user then dragged into their window loses its emulation first
// (Codex's review).
const panel = createPanel({ home: HOME, profiles: () => [...profiles.values()], call, mark: tabId => marks.get(tabId),
  beforeStill: async (tabId) => unlessAgents(tabId, await whose(tabId)) });

// What the pill in an agent's tab says it's doing, per command.
const USES = {
  snap: () => 'looking at the page',
  click: ({ tab, ref, text }) => `clicking ${text && text !== true ? `"${redact(String(text)).slice(0, 40)}"` : labelOf(tab, ref)}`,
  hover: () => 'pointing at something',
  type: () => 'typing',
  key: ({ key }) => `pressing ${key}`,
  goto: ({ url }) => `going to ${hostOf(url)}`,
  read: () => 'reading the page',
  secret: () => 'saving a key to a file',
  shot: () => 'taking a screenshot',
  eval: () => 'running a script',
  cdp: () => 'working',
  upload: () => 'uploading a file',
  download: () => 'downloading a file',
  dialog: () => 'answering a dialog',
  fill: () => 'signing in with 1Password',
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
  // frames: the tab's cross-origin iframes by targetId, as loadFrames last saw them.
  if (!tabState.has(tabId)) tabState.set(tabId, { refs: new RefMap(), last: null, dialog: null, frames: new Map() });
  return tabState.get(tabId);
};

// How long a command gets before BrowserBear asks why it hasn't come back.
// An env var so tests needn't wait 20 s.
const CDP_WAIT_MS = Number(process.env.BROWSERBEAR_CDP_WAIT_MS) || 20_000;
const PROBE_MS = Math.min(4_000, CDP_WAIT_MS);

// A node inside a cross-origin iframe is "<frame targetId>:<backendNodeId>",
// since backend ids are only unique within a process; one in the tab's own
// page is a plain number. cdp sends a command about either to the right
// session, so the code that clicks and types needn't care which it has.
const inFrame = (node) => typeof node === 'string';
const frameNode = (frame, id) => (frame ? `${frame}:${id}` : id);
const splitNode = (node) => {
  const i = node.lastIndexOf(':');
  return { frame: node.slice(0, i), id: Number(node.slice(i + 1)) };
};

// Remote objects made in a cross-origin frame live in its process, so later
// commands on them have to go there too. From Chrome 159 object ids are only
// unique within a process (the page and a frame can both have "0.1.1"), so a
// lookup by id alone sent the page's objects to the frame. Instead, an object
// from a frame is handed out as "<frame targetId>@<objectId>", like nodes
// above, and cdp unwraps it. Chrome's ids never have an "@" in them.
const frameObject = (frame, id) => `${frame}@${id}`;
const splitObject = (id) => {
  const i = typeof id === 'string' ? id.lastIndexOf('@') : -1;
  return i < 0 ? { frame: null, id } : { frame: id.slice(0, i), id: id.slice(i + 1) };
};

// `frame` says which iframe a command without a node or object in it is for.
async function cdp(tabId, method, params, timeoutMs = CDP_WAIT_MS, frame = null) {
  const p = await ownerOf(tabId);
  if (inFrame(params?.backendNodeId)) {
    const n = splitNode(params.backendNodeId);
    frame = n.frame;
    params = { ...params, backendNodeId: n.id };
  } else if (params?.objectId || params?.arguments) {
    // callFunctionOn's arguments can be objects too. They all have to live
    // where its target does: as ids repeat across processes, unwrapping a
    // mix and sending it to one session would quietly act on some other
    // object there. An untagged id is the page's, or the frame passed in.
    const ids = [params.objectId, ...(Array.isArray(params.arguments) ? params.arguments.map((a) => a?.objectId) : [])].filter(Boolean);
    const homes = new Set(ids.map((id) => splitObject(id).frame || frame));
    if (homes.size > 1) throw new Error(`BrowserBear bug: ${method} was given objects from different frames of tab ${tabId}`);
    if (homes.size) frame = [...homes][0];
    params = { ...params, ...(params.objectId ? { objectId: splitObject(params.objectId).id } : {}) };
    if (Array.isArray(params.arguments)) params.arguments = params.arguments.map((a) => (a?.objectId ? { ...a, objectId: splitObject(a.objectId).id } : a));
  }
  try {
    if (!frame) return await send(p, tabId, method, params, timeoutMs);
    const result = await sendToFrame(p, tabId, frame, method, params, timeoutMs);
    markObjects(frame, result);
    return result;
  } catch (e) {
    // A ref from before the tab went to another page, which Chrome only
    // reports as "Node with given id does not belong to the document".
    if (/does not belong to the document|No node with given id|Could not find node with given id/.test(e.message)) {
      throw new Error(`that ref is from a page tab ${tabId} has since left; snap ${tabId} for fresh refs`);
    }
    // The extension turns this into its own wording once it has tried clearing
    // the frame, so Chrome's wording arriving here means old code is still running
    // in that profile, reporting the current version (Discord, 2 Nov: a reload got
    // straight back in).
    if (/URL of different extension/.test(e.message)) throw new Error(`${describe(p)} is running older BrowserBear extension code, which can't clear another extension's frame out of tab ${tabId}. The page itself is fine; browserbear reload, then try again`);
    // Chrome's "No tab with given id" reads like a BrowserBear bug. What it means
    // is the page closed, usually by itself: a sign-in popup that's finished.
    if (/no tab with (given )?id/i.test(e.message)) throw Object.assign(new Error(closedMessage(tabId)), { closed: true });
    if (!/Cannot attach to this target/.test(e.message)) throw e;
    throw await refusal(p, tabId);
  }
}

// The tab's cross-origin iframes, fresh from the extension (or the agents'
// browser), as targetId -> { sessionId, url, parent targetId or null }. An
// extension from before frames gives none, which is how pages looked before.
async function loadFrames(tabId) {
  // A cut-off that lasts is an error, not a page with no frames: snap would
  // quietly leave out a payments form.
  const p = await ownerOf(tabId);
  const got = await whileCutOff(tabId, () => call(p, 'frames', { tabId })).catch((e) => {
    if (e.cutOff) throw e;
    return [];
  });
  const list = Array.isArray(got) ? got : [];
  const bySession = new Map(list.map((f) => [f.sessionId, f.targetId]));
  const frames = new Map(list.map((f) => [f.targetId, { sessionId: f.sessionId, url: f.url, parent: (f.parent && bySession.get(f.parent)) || null }]));
  state(tabId).frames = frames;
  return frames;
}

async function sendToFrame(p, tabId, frame, method, params, timeoutMs) {
  let f = state(tabId).frames.get(frame);
  let renewed = false;
  // Cut off (see send()): attaching again gives every frame a new session, so
  // each try asks for the frames afresh.
  return whileCutOff(tabId, async () => {
    for (;;) {
      if (!f) f = (await loadFrames(tabId)).get(frame);
      if (!f) throw new Error(`that ref is in a frame tab ${tabId} no longer has; snap ${tabId} for fresh refs`);
      try {
        return await call(p, 'cdp', { tabId, method, params, sessionId: f.sessionId }, timeoutMs);
      } catch (e) {
        // The extension detaches after 30 s idle, which ends the frame's session
        // too; asking for frames again gives the same frame a new one.
        f = null;
        if (renewed || CUT_OFF.test(e.message) || !/session/i.test(e.message)) throw e;
        renewed = true;
      }
    }
  });
}

// Tags each object id in a frame's reply with the frame (see frameObject).
// A RemoteObject (it has a type) gets its objectId tagged, but its value is
// the page's own data returned by value, which may well have an "objectId"
// key of its own, so it isn't gone into. A property descriptor's value is a
// RemoteObject, and has no type of its own, so that one is.
function markObjects(frame, result, depth = 0) {
  if (!result || typeof result !== 'object' || depth > 4) return;
  const remote = !Array.isArray(result) && typeof result.type === 'string';
  if (remote && typeof result.objectId === 'string' && !result.objectId.includes('@')) result.objectId = frameObject(frame, result.objectId);
  for (const [k, v] of Object.entries(result)) if (!(remote && k === 'value')) markObjects(frame, v, depth + 1);
}

// Brings a frame on screen, outermost iframe first, so a person watching
// (or a shot) sees what's clicked. Its clicks don't depend on it: they go to
// the frame itself (clickNode).
async function showFrame(tabId, frame) {
  const owners = [];
  for (let f = frame; f; f = state(tabId).frames.get(f)?.parent) {
    const parent = state(tabId).frames.get(f)?.parent || null;
    const { backendNodeId } = await cdp(tabId, 'DOM.getFrameOwner', { frameId: f }, undefined, parent);
    owners.unshift(frameNode(parent, backendNodeId));
  }
  for (const owner of owners) await cdp(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: owner }).catch(() => {});
}

// What went wrong loading a tab's page, if anything, as the extension saw it.
function loadFailure(tab) {
  if (!tab?.loadError) return null;
  const host = hostOf(tab.url);
  const what = /ERR_CERT/.test(tab.loadError) ? `certificate error on ${host}` : `${host} didn't load`;
  return `${what} (${tab.loadError}): tab ${tab.tabId} is on Chrome's error page`;
}

const wayOut = (tabId) => `browserbear goto ${tabId} <url> still works, or browserbear close ${tabId}`;

// Chrome won't let a debugger into its warning pages (certificate errors, Safe
// Browsing) or the Web Store, and "Cannot attach to this target" says nothing
// about that: a tab on a host with the wrong certificate looked broken for
// good (vireo.de, 31 Oct). `refused` lets the waits below stop early, since
// waiting won't get us in.
async function refusal(p, tabId) {
  const tab = (await call(p, 'tabs').catch(() => [])).find((t) => t.tabId === tabId);
  const failure = loadFailure(tab);
  const why = failure
    ? `${failure}, so read, snap and eval can't get in`
    : `Chrome won't let BrowserBear into tab ${tabId} (${tab ? `"${tab.title}" <${tab.url}>` : 'it may be gone'}): it's one of Chrome's warning pages, or a page extensions are kept out of, like the Web Store`;
  return Object.assign(new Error(`${why}. ${wayOut(tabId)}`), { refused: true });
}

// Chrome shows one "BrowserBear started debugging this browser" bar for the
// extension across every profile (it's keyed by extension id), and closes it the
// moment any tab can't take it, which detaches every BrowserBear session there is
// with canceled_by_user. Another profile's window opening did that, so each
// attach was cut off as it was made, for a minute at a time (Zoho, 17 Nov 2026:
// every burst of those in the log follows the cannstudios profile opening).
// "Not attached" means the command never reached the page, so it's safe to send
// again; the extension attaches afresh on the next one, as its onDetach forgot
// the old session.
const CUT_OFF = /Debugger is not attached/;
const CUT_OFF_WAIT_MS = Number(process.env.BROWSERBEAR_CUT_OFF_WAIT_MS) || 20_000;

// The budget is for being cut off, not for the command: one that gets in on
// the last try still has its own timeout.
// Once a command has waited the whole budget, the ones after it (and the
// looks that shrug off errors) fail at once until one gets in: a type, with
// its several looks before it types, added up to 80 s of waits (Codex's review).
async function whileCutOff(tabId, attempt) {
  const s = state(tabId);
  const wait = s.gaveUpAt && Date.now() - s.gaveUpAt < CUT_OFF_WAIT_MS ? 0 : CUT_OFF_WAIT_MS;
  for (const until = Date.now() + wait; ; ) {
    try {
      const result = await attempt();
      s.gaveUpAt = null;
      return result;
    } catch (e) {
      if (!CUT_OFF.test(e.message)) throw e;
      if (Date.now() >= until) {
        if (wait) s.gaveUpAt = Date.now();
        throw cutOffError(tabId, e);
      }
      await sleep(500);
    }
  }
}

const send = (p, tabId, method, params, timeoutMs) => whileCutOff(tabId, () => sendOnce(p, tabId, method, params, timeoutMs));

// cutOff: the waits for a page to load or draw stop at this rather than wait
// out the same 20 s again.
function cutOffError(tabId, e) {
  const why = state(tabId).cutOffAt
    ? `Chrome kept cutting BrowserBear's debugger off from tab ${tabId} as it attached (canceled_by_user, for ${Math.round(CUT_OFF_WAIT_MS / 1000)} s). Chrome does that to every BrowserBear session when one of its windows can't show the "started debugging this browser" bar, usually another Chrome profile's window that has just opened`
    : `BrowserBear's debugger kept losing tab ${tabId} (${e.message}) for ${Math.round(CUT_OFF_WAIT_MS / 1000)} s`;
  return Object.assign(new Error(`${why}. The page itself is fine and it usually clears within a minute: try again shortly, or close any Chrome window that's just opened`), { cutOff: true });
}

async function sendOnce(p, tabId, method, params, timeoutMs) {
  // Input has its own short wait, where running out means "probably landed".
  if (method.startsWith('Input.')) return call(p, 'cdp', { tabId, method, params }, timeoutMs);
  // Browser-side recovery must still work when the page's JavaScript is stuck.
  const recovery = /^(Page\.(getNavigationHistory|navigate|handleJavaScriptDialog)$|Emulation\.(clearDeviceMetricsOverride|setFocusEmulationEnabled)$|Target\.getTargetInfo$)/.test(method);
  if (state(tabId).stuck && !recovery) await stillStuck(p, tabId);
  try {
    // timeoutMs too, for the agents' browser, whose own wait is otherwise 30 s.
    return await call(p, 'cdp', { tabId, method, params, timeoutMs }, timeoutMs);
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
    throw stuckError(tabId, url);
  }
  log('session stuck', tabId, method);
  await call(p, 'detach', { tabId }, PROBE_MS).catch(() => {});
  if (!(await history().catch(() => null))) {
    const url = (await call(p, 'tabs').catch(() => [])).find((t) => t.tabId === tabId)?.url || '';
    throw Object.assign(new Error(`tab ${tabId}'s debugger session is stuck and starting a fresh one didn't help; reopen the page in a new tab: browserbear open ${url || '<url>'}`), { stuck: true });
  }
  if (LOOKS.test(method)) return call(p, 'cdp', { tabId, method, params }, CDP_WAIT_MS);
  // It may have run before the session stuck, so it isn't sent again.
  throw new Error(`tab ${tabId}'s debugger session was stuck, so BrowserBear started a fresh one; ${method} may or may not have run, snap to see before trying again`);
}

// stuck: the waits for a page to load or draw stop at this rather than ask
// again, since each ask is another 4 s at best: read on a dead tab in the
// agents' browser took 1 min 45 s to give up (12 Nov 2026).
const stuckError = (tabId, url) =>
  Object.assign(
    new Error(
      url
        ? `tab ${tabId}'s page isn't answering: Chrome is fine, but the page's own scripts are stuck or flat out (a live chart can do this). Try again in a bit, or close it and open the page fresh in a new tab: browserbear close ${tabId}; browserbear open ${url}`
        // Never got as far as a page at all: its renderer didn't start.
        : `tab ${tabId} never got a page to load in, so the browser couldn't start one for it; close it and open the page again in a new tab: browserbear close ${tabId}; browserbear open <url>`,
    ),
    { stuck: true },
  );

// Once a page has been stuck, a quick look first, so each command after it
// doesn't wait the full 20 s to say the same thing.
async function stillStuck(p, tabId) {
  const s = state(tabId);
  if (!(await pageAnswers(p, tabId))) throw stuckError(tabId, s.stuck.url);
  s.stuck = null;
}

const pageAnswers = (p, tabId) =>
  call(p, 'cdp', { tabId, method: 'Runtime.evaluate', params: { expression: '1' } }, PROBE_MS).then(() => true, () => false);

// Is the element at (x, y) the one we mean, or something inside it? A dialog
// still animating in, a toast or a transparent overlay can sit on top, and a
// real click then lands on that instead (Sentry's Remove Project dialog, 29 Oct).
async function hitsTarget(tabId, backendNodeId, at) {
  // In a frame, asked of the frame.
  const { frame, id } = inFrame(backendNodeId) ? splitNode(backendNodeId) : { frame: null, id: backendNodeId };
  // getNodeForLocation takes a point on the page, not in the window, so a
  // scrolled page's point is moved by its scroll. Without that, the check
  // looked at whatever was a scroll's height above, called it on top, and
  // turned real clicks into script clicks (17 Nov).
  const metrics = await cdp(tabId, 'Page.getLayoutMetrics', {}, PROBE_MS, frame).catch(() => null);
  const { pageX = 0, pageY = 0 } = metrics?.cssVisualViewport || {};
  const hit = await cdp(tabId, 'DOM.getNodeForLocation', { x: Math.round(at.x + pageX), y: Math.round(at.y + pageY), ignorePointerEventsNone: false }, undefined, frame).catch(() => null);
  if (!hit?.backendNodeId) return { ok: false, what: 'nothing' };
  if (hit.backendNodeId === id) return { ok: true };
  // Only what takes clicks: ignorePointerEventsNone: true means hit-test
  // pointer-events: none too, and so it found the Cloud console dialog's
  // see-through ::before border over AI Studio's payment form (19 Nov).
  // A pseudo-element that is hit stands for the element it belongs to: Chrome
  // resolves one into no world the page's own objects share, and the check
  // below then failed with "Argument should belong to the same JavaScript
  // world as target object".
  let hitId = hit.backendNodeId;
  const hitNode = (await cdp(tabId, 'DOM.describeNode', { backendNodeId: frameNode(frame, hitId) }).catch(() => null))?.node;
  if (hitNode?.pseudoType) {
    hitId = await pseudoOwner(tabId, frame, hitId);
    if (!hitId) return { ok: false, what: `a ::${hitNode.pseudoType} the page has since removed` };
    if (hitId === id) return { ok: true };
  }
  const [{ object: target }, { object: top }] = await Promise.all([
    cdp(tabId, 'DOM.resolveNode', { backendNodeId }),
    cdp(tabId, 'DOM.resolveNode', { backendNodeId: frameNode(frame, hitId) }),
  ]);
  const { result } = await cdp(tabId, 'Runtime.callFunctionOn', {
    objectId: target.objectId,
    arguments: [{ objectId: top.objectId }],
    functionDeclaration: `function (top) {
      const el = top.nodeType === 1 ? top : top.parentElement;
      if (this === el || this.contains(el)) return '';
      // A label that's pointer-events: none (a button's text, which --text
      // finds) is never hit; its button is, and gets the click as a person's would.
      if (el.contains(this) && getComputedStyle(this).pointerEvents === 'none') return '';
      return (el.getAttribute('aria-label') || el.tagName.toLowerCase()) + (el.id ? '#' + el.id : '');
    }`,
    returnByValue: true,
  }).catch((e) => {
    // Anything else from another world (a document of its own in the frame)
    // isn't the target, so it gets a script click rather than an error.
    if (/same JavaScript world/.test(e.message)) return { result: { value: 'something in another document' } };
    throw e;
  });
  return result.value ? { ok: false, what: result.value } : { ok: true };
}

// The element a pseudo-element belongs to, from the frame's whole tree, as
// Chrome tells a pseudo-element's node nothing of its parent.
async function pseudoOwner(tabId, frame, pseudo) {
  const { root } = await cdp(tabId, 'DOM.getDocument', { depth: -1, pierce: true }, undefined, frame);
  // Pseudo-elements can have their own (::before::marker).
  const holds = (n) => n.pseudoElements?.some((x) => x.backendNodeId === pseudo || holds(x));
  const find = (n) => {
    if (holds(n)) return n.backendNodeId;
    for (const c of [...(n.children || []), ...(n.shadowRoots || []), ...(n.contentDocument ? [n.contentDocument] : [])]) {
      const got = find(c);
      if (got) return got;
    }
    return null;
  };
  return find(root);
}

const within = async (tabId, backendNodeId, selector) => {
  const { object } = await cdp(tabId, 'DOM.resolveNode', { backendNodeId });
  const { result } = await cdp(tabId, 'Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: `function (selector) { return !!this.closest?.(selector); }`, arguments: [{ value: selector }], returnByValue: true });
  return result?.value === true;
};
const isLink = (tabId, backendNodeId) => within(tabId, backendNodeId, 'a[href]');
// What's clicked to make something happen, as opposed to a field clicked for focus.
const isButton = (tabId, backendNodeId) => within(tabId, backendNodeId, 'a[href], button, summary, input[type=submit], input[type=button], [role=button], [role=link], [role=menuitem]');

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
// In a cross-origin iframe too (frame), keyed by its own backend ids.
async function fileInputs(tabId, frame = null, timeoutMs = CDP_WAIT_MS) {
  try {
    const { root } = await cdp(tabId, 'DOM.getDocument', { depth: 0 }, timeoutMs, frame);
    const { nodeIds } = await cdp(tabId, 'DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'input[type=file]' }, timeoutMs, frame);
    if (!nodeIds.length) return new Map();
    // A styled <label> isn't a control in the tree, so its text is the only
    // name the input has. Same order as querySelectorAll above.
    const [nodes, names] = await Promise.all([
      Promise.all(nodeIds.map((nodeId) => cdp(tabId, 'DOM.describeNode', { nodeId }, timeoutMs, frame).then((r) => r.node))),
      cdp(tabId, 'Runtime.evaluate', { expression: `${FILE_INPUTS}.map(${FILE_LABEL})`, returnByValue: true }, timeoutMs, frame).then((r) => r.result?.value || [], () => []),
    ]);
    return fileInfo(nodes, names);
  } catch {
    return new Map(); // a snapshot without them beats no snapshot
  }
}

const FILE_INPUTS = `[...document.querySelectorAll('input[type=file]')]`;
const FILE_LABEL = `(i) => i.labels?.[0]?.innerText || i.getAttribute('aria-label') || i.title || ''`;

function fileInfo(nodes, names) {
  return new Map(
    nodes.map((n, i) => {
      const a = {};
      for (let j = 0; j < (n.attributes?.length || 0); j += 2) a[n.attributes[j]] = n.attributes[j + 1];
      return [n.backendNodeId, { id: a.id, label: names[i], accept: a.accept, multiple: 'multiple' in a, disabled: 'disabled' in a }];
    }),
  );
}

// The same for a frame that shares its parent's process (documents()), whose
// document the DOM domain's querySelectorAll can't be pointed at, so the
// inputs are found in an isolated world made in it.
async function inProcessFileInputs(tabId, id, doc) {
  try {
    const arr = (await evalIn(tabId, id, doc, FILE_INPUTS, { byValue: false })).result?.objectId;
    if (!arr) return new Map();
    const [{ result: props }, names] = await Promise.all([
      cdp(tabId, 'Runtime.getProperties', { objectId: arr, ownProperties: true }, PROBE_MS, doc.session),
      cdp(tabId, 'Runtime.callFunctionOn', { objectId: arr, functionDeclaration: `function () { return this.map(${FILE_LABEL}); }`, returnByValue: true }, PROBE_MS, doc.session).then((r) => r.result?.value || [], () => []),
    ]);
    const els = props.filter((p) => /^\d+$/.test(p.name)).sort((a, b) => a.name - b.name);
    const nodes = await Promise.all(els.map((p) => cdp(tabId, 'DOM.describeNode', { objectId: p.value.objectId }, PROBE_MS, doc.session).then((r) => r.node)));
    return fileInfo(nodes, names);
  } catch {
    return new Map();
  }
}

// BrowserBear's window usually sits behind your other windows or on a screen
// you aren't looking at, and Chrome stops drawing a window that's covered:
// its pages go hidden, with no animation frames, IntersectionObservers or
// ResizeObservers. Pages that draw lazily then never fill in; YouTube Studio's
// analytics showed the Reach tab over an empty body (31 Oct). Focus emulation
// has Chrome treat the page as visible and focused while the debugger is
// attached, and the extension detaches after 30 s idle, so it's checked before
// every look. Only agents' tabs: one of your own pages thinking it has focus
// could, say, mark your messages read.
//
// Hidden also means Chrome throttles the page's timers (once a second, then
// once a minute after 5 minutes), and single-page apps render on timers:
// YouTube Studio took a minute a page in a tab behind another, 8 s in front
// (17 Nov). Focus emulation lifts that too, but only while the debugger is
// attached, so every command on a tab wakes it first (onClientMessage), not
// just the looks: an eval loop polling for a table never got woken.
// Returns true when the tab is hidden and left so (not the agent's).
// draw: false skips waiting for what it held back, for commands that act
// rather than look: a click held up to 6 s behind a busy page could miss
// what it was for (Codex's review). The snapshot after it waits instead.
async function wake(tabId, { draw = true, owner } = {}) {
  // Whose it is now, not whether an agent once opened it: one dragged into
  // the user's own window, or handed to them, is theirs (Codex's review).
  // Not knowing (the tab list didn't have it yet) means not emulating, rather
  // than failing the command over it.
  owner ??= await whose(tabId).catch(() => ({ who: null }));
  const look = () => evaluate(tabId, 'document.visibilityState').catch(unlessStuck);
  if (!agentsNow(owner)) {
    // Off every time, not just when BrowserBear remembers turning it on: a
    // restarted service forgets, and the debugger can outlive it (Codex's
    // review). Before the look, which emulation would answer "visible".
    await unlessAgents(tabId, owner, { always: true });
    // A JS dialog freezes the page, so there's no looking until it's answered.
    return !state(tabId).dialog && (await look()) === 'hidden';
  }
  if (state(tabId).dialog || (await look()) !== 'hidden') return false;
  await emulateFocus(tabId);
  if (draw) await drawn(tabId); // what it held back
  return false;
}

// whose() counts a tab as the agent's on the word of an extension too old to
// say (no bear field); an explicit agent: false never is (Codex's review).
const agentsNow = (owner) => owner.who === 'agent' && owner.t.agent !== false;
// Tabs BrowserBear has turned focus emulation on in, so that one which has
// since become the user's (dragged into their window mid-loop) has it turned
// off before the next command, even one refused for being on their tab.
const emulated = new Set();
async function emulateFocus(tabId) {
  await cdp(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true });
  emulated.add(tabId);
}
async function unlessAgents(tabId, owner, { always = false } = {}) {
  if (agentsNow(owner) || !(always || emulated.has(tabId))) return;
  // Forgotten only once it's really off, so a failed try is tried again.
  await cdp(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: false }).then(
    () => emulated.delete(tabId),
    () => {},
  );
}

// Commands that wake the tab before they run. snap, read, shot and open wake
// it themselves as well, at the point they look. goto is handled apart, in
// onClientMessage. show brings it forward anyway; dialog and fill work on a
// page that's waiting on them.
// Keys in well-known formats, blanked in everything BrowserBear prints, so
// one a page shows (AI Studio after "Show key") doesn't land in the agent's
// transcript through a snap, click diff, read or eval. browserbear secret
// saves one to a file instead. Screenshots still show them.
const KEY_FORMATS = [
  /AIza[0-9A-Za-z_-]{35}/g, // Google
  /(?<![A-Za-z0-9])sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, // Anthropic, OpenAI and others
  /(?<![A-Za-z0-9])(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, // Stripe
  /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}/g, // GitHub
  /(?<![A-Za-z0-9])xox[abposr]-[A-Za-z0-9-]{10,}/g, // Slack
  /(?<![A-Z0-9])AKIA[0-9A-Z]{16}(?![A-Z0-9])/g, // AWS
];
// The start of one, cut short where a long name is clipped with "…".
const KEY_CLIPPED = /(?:AIza|(?<![A-Za-z0-9])(?:sk-|(?:sk|rk)_(?:live|test)_|gh[pousr]_|github_pat_|xox[abposr]-)|(?<![A-Z0-9])AKIA)[A-Za-z0-9_-]{4,}(?=…)/g;
const redactText = (text) =>
  // Clipped ones first: a long key cut short can still look whole, and its
  // "end" would be from the middle (Codex's review).
  KEY_FORMATS.reduce((t, re) => t.replace(re, (k) => `[a key ending ${k.slice(-4)}; browserbear secret saves it to a file]`), text.replace(KEY_CLIPPED, '[part of a key]'));
// Strings anywhere in a reply: eval of an object, a raw cdp result (Codex's review).
const redact = (v, depth = 0) => {
  if (typeof v === 'string') return redactText(v);
  if (!v || typeof v !== 'object') return v;
  if (depth > 50) return '[too deep to show]';
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [redactText(k), redact(x, depth + 1)]));
};

// A field's value, or an element's text.
const READ_SECRET = `function () {
  const el = this.nodeType === 1 ? this : this.parentElement;
  if (el.matches('input, textarea, select')) return el.value;
  return el.innerText ?? el.textContent;
}`;

const WAKES = new Set(['secret', 'eval', 'click', 'hover', 'type', 'key', 'upload', 'snap', 'read', 'shot']);
const LOOKS_FIRST = new Set(['snap', 'read', 'shot']);
const hiddenNote = (tabId) =>
  `note: tab ${tabId} is hidden (behind another tab or window), so Chrome slows its timers and pages that draw on them (YouTube Studio's analytics) can take a minute to fill in. It's one of the user's own tabs, so BrowserBear doesn't make it think it's in front; browserbear show ${tabId} brings it forward in its window.`;

// Loaded isn't drawn: an app like YouTube Studio fetches and draws its
// reports for another 2-3 s after readyState is complete, and a read straight
// after goto got the page's frame with nothing in it (31 Oct). So this waits
// until nothing has been added or removed for a moment. Text changing in
// place doesn't count, or a live counter would hold it to the cap.
const QUIET_MS = 500;
const DRAWN_CAP_MS = 6_000;
const DRAWN = `new Promise((resolve) => {
  let quiet;
  const done = () => { watch.disconnect(); clearTimeout(quiet); clearTimeout(cap); resolve(true); };
  const element = (n) => n.nodeType === 1;
  const watch = new MutationObserver((records) => {
    if (!records.some((r) => [...r.addedNodes, ...r.removedNodes].some(element))) return;
    clearTimeout(quiet);
    quiet = setTimeout(done, ${QUIET_MS});
  });
  watch.observe(document, { subtree: true, childList: true });
  quiet = setTimeout(done, ${QUIET_MS});
  const cap = setTimeout(done, ${DRAWN_CAP_MS});
})`;

async function drawn(tabId) {
  await evaluate(tabId, DRAWN).catch(unlessStuck);
}

// Every iframe in the tab, by frame id: { session, parent, url, inProcess }.
// session is the cross-origin frame whose debugger session reaches it (null
// for the tab's own); parent is the frame it sits in (null for the page).
// Cross-origin isn't always another process: a frame from the same site on
// another port shares the page's, gets no session of its own, and the page's
// accessibility tree leaves it out all the same, so each session's frame tree
// is walked for those too.
async function documents(tabId) {
  const oopifs = await loadFrames(tabId);
  const docs = new Map([...oopifs].map(([id, f]) => [id, { session: id, parent: f.parent, url: f.url, inProcess: false }]));
  const walk = (node, parent, session) => {
    for (const child of node.childFrames || []) {
      const id = child.frame.id;
      // Its own session walks what's inside it.
      if (oopifs.has(id)) docs.get(id).parent = parent;
      else {
        docs.set(id, { session, parent, url: child.frame.url, inProcess: true });
        walk(child, id, session);
      }
    }
  };
  await Promise.all(
    [null, ...oopifs.keys()].map(async (session) => {
      const tree = await cdp(tabId, 'Page.getFrameTree', {}, PROBE_MS, session).then((r) => r.frameTree, unlessCutOff);
      if (tree) walk(tree, session, session);
    }),
  );
  return docs;
}

// Evaluates in one of documents()'s frames. One that shares a process with
// its parent is reached through an isolated world made in it.
async function evalIn(tabId, id, doc, expression, { timeoutMs = PROBE_MS, byValue = true } = {}) {
  if (!doc.inProcess) return cdp(tabId, 'Runtime.evaluate', { expression, returnByValue: byValue }, timeoutMs, id);
  const { executionContextId } = await cdp(tabId, 'Page.createIsolatedWorld', { frameId: id, worldName: 'browserbear' }, timeoutMs, doc.session);
  return cdp(tabId, 'Runtime.evaluate', { expression, returnByValue: byValue, contextId: executionContextId }, timeoutMs, doc.session);
}

// A frame's text for read. A body that isn't rendered (its iframe is
// display:none, or the frame has no size) gives textContent from innerText,
// inline scripts and all: Gmail's hidden studio.workspace.google.com helper
// frame put 4 KB of JavaScript into read (11 Nov). So only a drawn body is read.
const FRAME_TEXT = `(() => {
  const b = document.body;
  // A display:contents body has no box of its own but its children are drawn,
  // and innerText reads it as rendered.
  const drawn = b && (b.checkVisibility() || (getComputedStyle(b).display === 'contents' && document.documentElement.checkVisibility()));
  if (!drawn || !innerWidth || !innerHeight) return '';
  return b.innerText;
})()`;

// Whether the iframe holding a frame is drawn with some size, asked of the
// element in its parent: visibility:hidden on the iframe, or a 0x0 one, isn't
// something the frame can always see from inside. A frame 1px across counts as
// hidden too: that's a tracking pixel, not something to read. Unknown counts as shown, so
// a slow parent doesn't lose a frame's text.
async function frameShown(tabId, id, d, docs) {
  try {
    const parent = d.parent === null ? null : docs.has(d.parent) ? docs.get(d.parent).session : d.parent;
    const { backendNodeId } = await cdp(tabId, 'DOM.getFrameOwner', { frameId: id }, PROBE_MS, parent);
    const { object } = await cdp(tabId, 'DOM.resolveNode', { backendNodeId }, PROBE_MS, parent);
    const { result } = await cdp(
      tabId,
      'Runtime.callFunctionOn',
      {
        objectId: object.objectId,
        functionDeclaration: `function () {
          const r = this.getBoundingClientRect();
          return r.width > 1 && r.height > 1 && this.checkVisibility({ visibilityProperty: true, opacityProperty: true });
        }`,
        returnByValue: true,
      },
      PROBE_MS,
      parent,
    );
    return result?.value !== false;
  } catch (e) {
    // Cut off isn't a slow parent: read would leave the frame's text out.
    if (e.cutOff) throw e;
    return true;
  }
}

// The accessibility tree of each iframe, which element in its parent holds
// it, and a cross-origin one's file inputs.
async function frameTrees(tabId) {
  const docs = await documents(tabId);
  // A frame sharing the page's process has session null, which is the tab's.
  const sessionOf = (id) => (id === null ? null : docs.has(id) ? docs.get(id).session : id);
  await Promise.all(
    [...docs].map(async ([id, d]) => {
      // A short wait: one stuck ad frame mustn't hold up a look at the page.
      [d.nodes, d.owner, d.files] = await Promise.all([
        cdp(tabId, 'Accessibility.getFullAXTree', d.inProcess ? { frameId: id } : {}, PROBE_MS, d.session).then((r) => r.nodes, unlessCutOff),
        cdp(tabId, 'DOM.getFrameOwner', { frameId: id }, PROBE_MS, sessionOf(d.parent)).then((r) => r.backendNodeId, unlessCutOff),
        d.inProcess ? inProcessFileInputs(tabId, id, d) : fileInputs(tabId, id, PROBE_MS),
      ]);
    }),
  );
  return docs;
}

// Drawn elements with no role of their own that the page handles clicks on,
// for snapshot.mjs's compact to list as "clickable" (see there for why).
// DOMSnapshot gives the lot in one call: isClickable is Chrome's own "has a
// click, mousedown or mouseup listener, or is a link", and cursor: pointer
// catches pages that listen once on the document (jQuery's delegated
// handlers) instead. cursor is inherited, so only where it starts counts.
// The tab's own process only: a cross-origin frame's controls come from its tree.
async function clickables(tabId) {
  const out = new Map();
  const snap = await cdp(tabId, 'DOMSnapshot.captureSnapshot', { computedStyles: ['cursor', 'visibility'] }, PROBE_MS).catch(() => null);
  if (!Array.isArray(snap?.documents)) return out;
  const str = (i) => (i >= 0 ? snap.strings[i] : '');
  for (const d of snap.documents) {
    const n = d.nodes;
    if (!n?.backendNodeId || !d.layout?.nodeIndex) continue;
    const box = new Map(); // node index -> [cursor, visibility, width, height]
    d.layout.nodeIndex.forEach((ni, li) => {
      const [x, y, w, h] = d.layout.bounds[li];
      box.set(ni, [str(d.layout.styles[li][0]), str(d.layout.styles[li][1]), w, h]);
    });
    const listens = new Set(n.isClickable?.index || []);
    // The nearest ancestor that's drawn: one with display: contents has no box.
    const drawnParent = (i) => {
      for (let p = n.parentIndex[i]; p >= 0; p = n.parentIndex[p]) if (box.has(p)) return box.get(p);
      return null;
    };
    const attrsOf = (i) => {
      const attrs = {};
      const a = n.attributes[i] || [];
      for (let k = 0; k + 1 < a.length; k += 2) attrs[str(a[k])] = str(a[k + 1]);
      return attrs;
    };
    // A label that opens a file input is already listed as that file-input.
    const fileLabels = new Set();
    const fileIds = new Set();
    for (let i = 0; i < n.backendNodeId.length; i++) {
      if (str(n.nodeName[i]) !== 'INPUT' || attrsOf(i).type?.toLowerCase() !== 'file') continue;
      if (attrsOf(i).id) fileIds.add(attrsOf(i).id);
      for (let p = n.parentIndex[i]; p >= 0; p = n.parentIndex[p]) if (str(n.nodeName[p]) === 'LABEL') fileLabels.add(p);
    }
    for (let i = 0; i < n.backendNodeId.length; i++) {
      if (n.nodeType[i] !== 1) continue;
      const b = box.get(i);
      if (!b || b[1] === 'hidden' || !(b[2] > 0 && b[3] > 0)) continue;
      const tag = str(n.nodeName[i]).toLowerCase();
      if (tag === 'html' || tag === 'body') continue;
      const pointerStarts = b[0] === 'pointer' && drawnParent(i)?.[0] !== 'pointer';
      if (!listens.has(i) && !pointerStarts) continue;
      const attrs = attrsOf(i);
      if (tag === 'label' && (fileLabels.has(i) || fileIds.has(attrs.for))) continue;
      const label = attrs['aria-label'] || attrs.title || attrs.alt || `${tag}${attrs.class ? '.' + attrs.class.trim().split(/\s+/)[0] : ''}`;
      out.set(n.backendNodeId[i], { label });
    }
  }
  return out;
}

async function snapshot(tabId, { full = false } = {}) {
  const s = state(tabId);
  // A JS dialog freezes the page, so every other call would just time out.
  if (s.dialog) return `tab ${tabId}\n${dialogLine(tabId, s.dialog)}`;
  await wake(tabId);
  await cdp(tabId, 'Page.enable');
  const [{ nodes }, files, frames, clicks] = await Promise.all([cdp(tabId, 'Accessibility.getFullAXTree'), fileInputs(tabId), frameTrees(tabId), clickables(tabId)]);
  const masked = (await stillFilled(tabId)) || undefined;
  // Each cross-origin iframe's controls go where the iframe is in its parent,
  // numbered from the same refs as the page's own.
  // A frame sharing the page's process has the page's node ids, so the page's
  // refs; one in its own process has its session's.
  const linesFor = (frame, axNodes) => {
    const inline = new Map();
    for (const [id, f] of frames) {
      if (f.parent !== frame || !f.nodes) continue;
      const inner = linesFor(id, f.nodes);
      if (inner.length) inline.set(f.owner ?? `unplaced ${id}`, [`[frame ${hostOf(f.url) || f.url}]`, ...inner]);
    }
    const session = frame && frames.get(frame).session;
    const refs = session ? { ref: (id) => s.refs.ref(frameNode(session, id)) } : s.refs;
    return compact(axNodes, refs, frame ? frames.get(frame).files : files, frame ? undefined : masked, inline, session ? undefined : clicks);
  };
  const lines = linesFor(null, nodes);
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
  await evaluate(tabId, MARK).catch((e) => {
    // Cut off already took its 20 s; the command after this would take another.
    if (e.cutOff) throw e;
  });
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
    // Refused: it went to a warning page, which won't change by waiting, and
    // the snapshot after this says so.
    const look = await evaluate(tabId, `[window.__browserbear ?? null, document.readyState]`).catch((e) => {
      if (e.cutOff) throw e;
      return e.refused ? ['here'] : null;
    });
    if (!look && (await tabNow(tabId)) === null) return; // it closed, which isn't going to load
    const [mark, ready] = look || ['leaving'];
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

// Some buttons act after the settle: Google's "Continue" popup for claude.ai
// waits on its server and then closes itself, so click said "(no change)" and
// suggested --script, and the retry hit a tab that had gone (5 Nov). So a button
// that seems to have done nothing gets a little longer before that's reported.
const LATE_MS = 2_500;

async function lateEffect(tabId) {
  const start = await tabNow(tabId);
  for (const until = Date.now() + LATE_MS; Date.now() < until; ) {
    await sleep(250);
    const now = await tabNow(tabId);
    if (now === null || now?.url !== start?.url) break;
  }
  await settleAfterAction(tabId);
}

// Runs something that can end with its own tab closing. That isn't a failure:
// it's how a sign-in popup says it's finished, and it can happen part-way through
// a command, which then fails on whatever it tried next. A tab that had already
// gone before this started is a real error, or a retry would claim it had worked,
// and so is one that went before anything was sent to it: `act` calls its argument
// just before it does. Even then a closed tab doesn't prove the sign-in succeeded,
// so the note says what was seen and where to look.
async function orClosed(tabId, act) {
  await ownerOf(tabId);
  if ((await tabNow(tabId)) === null) throw new Error(closedMessage(tabId));
  let sent = false;
  try {
    return await act(() => {
      sent = true;
    });
  } catch (e) {
    // Chrome can say the session ended a moment before the tab leaves its list.
    const looksClosed = /has closed|detached|not attached|target closed|no tab/i.test(e.message);
    for (let i = looksClosed ? 5 : 1; i > 0; i--) {
      if ((await tabNow(tabId)) === null) {
        tabState.delete(tabId);
        marks.closed(tabId);
        tabOwner.delete(tabId);
        bearTabs.delete(tabId);
        sentTo.delete(tabId);
        if (!sent) throw new Error(closedMessage(tabId));
        return `(tab ${tabId} closed straight after that, which is what a sign-in popup does when it has finished, so don't retry it. See whether the tab that opened it moved on: browserbear tabs lists what's open)`;
      }
      if (i > 1) await sleep(200);
    }
    throw e;
  }
}

// In a cross-origin frame, the point is from the frame's own corner.
async function center(tabId, backendNodeId) {
  if (inFrame(backendNodeId)) await showFrame(tabId, splitNode(backendNodeId).frame).catch(() => {});
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
// hover: move the pointer onto it first and give the page a moment, for
// elements that only work once they've been hovered (Zoho's campaign cards).
async function clickNode(tabId, backendNodeId, { script = false, hover = false, sending = () => {} } = {}) {
  const p = await ownerOf(tabId);
  let tab = (await call(p, 'tabs')).find((t) => t.tabId === tabId);
  if (!tab?.active && bearTabs.has(tabId)) tab = await call(p, 'show', { tabId });
  if (script) {
    sending();
    if (hover) await scriptHover(tabId, backendNodeId);
    await scriptClick(tabId, backendNodeId);
    return '(script click, as asked)';
  }
  let at = tab?.active ? await center(tabId, backendNodeId) : null;
  if (at && hover) {
    sending();
    await moveTo(tabId, backendNodeId, at).catch(() => {});
    await sleep(HOVER_MS);
    // Hovering can move things about (a revealed button pushing its row).
    at = await center(tabId, backendNodeId);
  }
  if (!at) {
    sending();
    if (hover) await scriptHover(tabId, backendNodeId);
    await scriptClick(tabId, backendNodeId);
    return tab?.active ? '' : `(tab ${tabId} is in the background, so that was a script click; browserbear show ${tabId} brings it forward for a real one)`;
  }
  const hit = await hitsTarget(tabId, backendNodeId, at);
  if (!hit.ok) {
    sending();
    await scriptClick(tabId, backendNodeId);
    return `(${hit.what} was on top of it, so that was a script click)`;
  }
  const base = { x: at.x, y: at.y, button: 'left', clickCount: 1 };
  // No separate mouseMoved first: each input event waits for the page to draw
  // a frame (1.5-3 s apiece on a busy Mac, 29 Oct), and pressed at x,y
  // already moves the pointer there.
  sending();
  try {
    // A cross-origin frame gets its clicks itself, at its own coordinates. Sent
    // to the tab at page coordinates, Chrome sometimes still had the frame where
    // it was before a scroll and gave the click to the page under it, even with
    // a mouseMoved first (Chrome for Testing, 10 Nov); sent to the frame, never.
    const frame = inFrame(backendNodeId) ? splitNode(backendNodeId).frame : null;
    await cdp(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mousePressed' }, INPUT_WAIT_MS, frame);
    await cdp(tabId, 'Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' }, INPUT_WAIT_MS, frame);
  } catch (e) {
    if (!/timed out/.test(e.message)) throw e;
    return `(the page hadn't confirmed the click after ${INPUT_WAIT_MS / 1000} s, so it's busy; the click has probably landed, check below before retrying)`;
  }
  return '';
}

const HOVER_MS = 300;

// The pointer onto a node, as the user's mouse would be. In a cross-origin
// frame, sent to the frame at its own coordinates, as clicks are.
function moveTo(tabId, backendNodeId, at) {
  const frame = inFrame(backendNodeId) ? splitNode(backendNodeId).frame : null;
  return cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y }, INPUT_WAIT_MS, frame);
}

// What a page's own handlers see of a hover, for a tab that can't take real
// input. CSS :hover doesn't follow, so a button shown by CSS stays hidden.
const SCRIPT_HOVER = `function () {
  const o = { bubbles: true, cancelable: true, composed: true, view: window };
  const p = { ...o, pointerType: 'mouse', isPrimary: true };
  this.dispatchEvent(new PointerEvent('pointerover', p));
  this.dispatchEvent(new PointerEvent('pointerenter', { ...p, bubbles: false }));
  this.dispatchEvent(new MouseEvent('mouseover', o));
  this.dispatchEvent(new MouseEvent('mouseenter', { ...o, bubbles: false }));
  this.dispatchEvent(new PointerEvent('pointermove', p));
  this.dispatchEvent(new MouseEvent('mousemove', o));
}`;

async function scriptHover(tabId, backendNodeId) {
  const { object } = await cdp(tabId, 'DOM.resolveNode', { backendNodeId });
  await cdp(tabId, 'Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: SCRIPT_HOVER });
}

// A real hover where the tab can take one (see clickNode), else a script one.
async function hoverNode(tabId, backendNodeId, sending = () => {}) {
  const p = await ownerOf(tabId);
  let tab = (await call(p, 'tabs')).find((t) => t.tabId === tabId);
  if (!tab?.active && bearTabs.has(tabId)) tab = await call(p, 'show', { tabId });
  const at = tab?.active ? await center(tabId, backendNodeId) : null;
  sending();
  if (at) {
    try {
      await moveTo(tabId, backendNodeId, at);
    } catch (e) {
      if (!/timed out/.test(e.message)) throw e;
    }
    return '';
  }
  await scriptHover(tabId, backendNodeId);
  return tab?.active
    ? '(it has no box to point at, so that was a script hover)'
    : `(tab ${tabId} is in the background, so that was a script hover, which doesn't set CSS :hover; browserbear show ${tabId} brings it forward for a real one)`;
}

// Finds what click and hover were pointed at by --css or --text rather than a
// ref, for controls a snapshot can't name. Zoho Campaigns (17 Nov): an agent
// fell back to eval'd mouse events for divs, a hover-revealed button and
// <a title=Edit> icons, and some of those clicks silently did nothing.
// Returns [element, the nearest drawn ancestor of a hidden one, JSON info].
// Open shadow roots are searched too, and iframes by resolveTarget, which
// runs this in each one.
const FIND = `function (css, text, nth, peek) {
  const tidy = (s) => String(s ?? '').replace(/\\s+/g, ' ').trim();
  const norm = (s) => tidy(s).toLowerCase();
  const all = (root, sel) => {
    const out = [...root.querySelectorAll(sel)];
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) out.push(...all(el.shadowRoot, sel));
    return out;
  };
  const up = (el) => el.parentElement || el.getRootNode().host || null;
  const drawn = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  };
  const clip = (t, n) => (t.length > n ? t.slice(0, n - 1) + '…' : t);
  const said = (el) => [el.innerText, el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('alt'), ['submit', 'button', 'reset'].includes(el.type) ? el.value : null].map(tidy).filter(Boolean);
  const names = (el) => said(el).map(norm);
  // Which one it is: its own words, and those of the nearest thing around
  // it that says more (its row, its card), since the matches all say the same.
  const describe = (el) => {
    let d = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/)[0] : '');
    const own = said(el)[0] || '';
    if (own) d += ' "' + clip(own, 40) + '"';
    for (let a = up(el), i = 0; a && a !== document.body && i < 6; a = up(a), i++) {
      const ctx = tidy(a.innerText);
      if (ctx && ctx !== own) {
        d += ' in "' + clip(ctx, 50) + '"';
        break;
      }
    }
    return d;
  };
  // Whether a holds b, across shadow roots (contains() stops at them).
  const holds = (a, b) => {
    for (let x = b; x; x = up(x)) if (x === a) return true;
    return false;
  };
  // Only the innermost of a nest that all match, as <div><p>Save</p></div> do.
  // One walk up from each, not every pair: a table of 10,000 "Edit"s would
  // stall the page (Codex's review, 17 Nov).
  const innermost = (els) => {
    const outer = new Set();
    for (const el of els) for (let a = up(el); a; a = up(a)) outer.add(a);
    return els.filter((el) => !outer.has(el));
  };
  // Drawn ones first, so <button aria-label=Delete> isn't passed over for a
  // hidden tooltip inside it that also says "Delete" (Codex's review).
  const pick = (els) => {
    const shown = els.filter(drawn);
    return shown.length ? { els: innermost(shown), hidden: false } : { els: innermost(els), hidden: true };
  };
  let found;
  let what;
  if (css) {
    what = 'the selector "' + css + '"';
    try {
      found = pick(all(document, css));
    } catch (e) {
      return [null, null, JSON.stringify({ error: '"' + css + '" is not a CSS selector that works: ' + e.message })];
    }
  } else {
    what = 'the text "' + text + '"';
    const want = norm(text);
    const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'TITLE', 'META', 'LINK', 'HTML', 'BODY']);
    // textContent first: it's cheaper than innerText, which lays the text out.
    const attrs = (el) => ['aria-label', 'title', 'alt'].some((a) => norm(el.getAttribute(a)).includes(want)) || norm(el.value).includes(want);
    // Without spaces, as layout adds some textContent hasn't got (a <br>).
    const squash = (t) => norm(t).replace(/ /g, '');
    const els = all(document, '*').filter((el) => !skip.has(el.tagName) && (squash(el.textContent).includes(squash(want)) || attrs(el)));
    found = pick(els.filter((el) => names(el).includes(want)));
    // Nothing says exactly that: then anything with it in, innermost first.
    if (!found.els.length) found = pick(els.filter((el) => names(el).some((n) => n.includes(want))));
  }
  // For --reveal: whether a drawn match is there already. Errors above (a bad
  // selector) still come back as errors, so nothing gets clicked over them.
  if (peek) return [null, null, JSON.stringify({ shown: found.els.length > 0 && !found.hidden, none: !found.els.length })];
  // none: so resolveTarget knows to look in the page's iframes next.
  if (!found.els.length) return [null, null, JSON.stringify({ error: 'nothing in the page matches ' + what, none: true })];
  let pool = found.els;
  const hidden = found.hidden;
  if (!hidden) {
    // Under a dialog or overlay, only what's on top can be clicked: the
    // dialog's own "Delete", not the row's behind it. Hit-tested through
    // shadow roots, where elementFromPoint only gives the host.
    const at = (x, y) => {
      let hit = document.elementFromPoint(x, y);
      while (hit?.shadowRoot) {
        const inner = hit.shadowRoot.elementFromPoint(x, y);
        if (!inner || inner === hit) break;
        hit = inner;
      }
      return hit;
    };
    // Whether what's over a match is a backdrop over the whole page, as a
    // modal puts up, rather than a sticky header or a tooltip over one row.
    const backdrop = (el, hit) => {
      for (let a = hit; a && !holds(a, el); a = up(a)) {
        if (a.nodeType !== 1) continue;
        // Only the part on screen: a tall side panel isn't a backdrop.
        const r = a.getBoundingClientRect();
        const w = Math.min(r.right, innerWidth) - Math.max(r.left, 0);
        const h = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
        if (w > 0 && h > 0 && w * h >= 0.9 * innerWidth * innerHeight) return true;
      }
      return false;
    };
    const onScreen = [];
    let behindBackdrop = false;
    for (const el of pool) {
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
      const hit = at(x, y);
      if (!hit || holds(el, hit) || holds(hit, el)) onScreen.push(el);
      else if (backdrop(el, hit)) behindBackdrop = true;
    }
    // Behind a backdrop, so what's off screen is behind it too. Anything less
    // leaves every match in, and two is an error rather than a guess at the
    // one in view: a wrong guess could delete the wrong row (Codex's review).
    if (behindBackdrop && onScreen.length) pool = onScreen;
    // In a modal dialog, it's the dialog's. :modal, as a dialog opened with
    // show() has [open] too and leaves the page usable.
    const modal = pool.filter((el) => { for (let a = el; a; a = up(a)) if (a.nodeType === 1 && a.matches(':modal, [aria-modal=true]')) return true; return false; });
    if (modal.length && modal.length < pool.length) pool = modal;
  }
  // hidden on these too, so resolveTarget can tell several drawn matches (an
  // answer in itself) from several hidden ones (worth looking in iframes).
  if (nth > pool.length) return [null, null, JSON.stringify({ error: what + ' matches ' + pool.length + ', so there is no number ' + nth, hidden })];
  if (pool.length > 1 && !nth) {
    const list = pool.slice(0, 8).map((el, i) => '  ' + (i + 1) + '. ' + describe(el)).join('\\n');
    return [null, null, JSON.stringify({ error: what + ' matches ' + pool.length + (hidden ? ' hidden elements' : '') + '. Say which with --nth <n>, or narrow it:\\n' + list + (pool.length > 8 ? '\\n  ...' : ''), hidden })];
  }
  const el = pool[(nth || 1) - 1];
  let revealer = null;
  if (hidden) for (let a = up(el); a && !revealer; a = up(a)) if (a.nodeType === 1 && drawn(a)) revealer = a;
  return [el, revealer, JSON.stringify({ desc: describe(el), revealer: revealer && describe(revealer), hidden })];
}`;

const isRef = (target) => /^e\d+$/.test(target);

// The node a click or hover means: a ref from a snapshot, or one found by
// --css or --text, which then gets a ref of its own for next time. A hidden
// match (a button that only shows while its card is hovered) is revealed by
// hovering the nearest ancestor that's drawn.
// peek: only whether a drawn match is there already, with no hovering.
// script: the click will be a script one, which needs nothing drawn, so a
// hidden match is clicked where it is rather than hovered into view.
async function resolveTarget(tabId, { ref, css, text, nth, peek = false, script = false }, sending) {
  if (css === true || text === true) throw new Error(`--${css === true ? 'css' : 'text'} needs a value`);
  if (nth !== undefined && !(Number.isInteger(nth) && nth > 0)) throw new Error('--nth takes a number from 1');
  if (ref && isRef(ref) && !css && !text) return { node: await nodeFor(tabId, ref), ref, note: '' };
  // A selector where the ref goes, as upload takes one.
  if (ref && !css && !text) css = ref;
  if (!css && !text) throw new Error('say what to act on: a ref from browserbear snap (e12), --css <selector> or --text <text>');
  const expression = `(${FIND})(${JSON.stringify(css || null)}, ${JSON.stringify(text || null)}, ${nth || 0}, ${peek})`;
  const used = new Set([null]); // the sessions with objects to let go of
  try {
    let hit = await findIn(tabId, expression, null);
    // Not drawn in the page itself: then in its iframes. Google Drive's share
    // dialog is one (17 Nov), and --text "Restricted" said nothing matched.
    // Several matches in the page is its error, as is a bad selector: those
    // stand, rather than a lone match in some frame being taken instead.
    const lookFurther = hit.info.none || (peek ? !hit.info.shown : hit.info.hidden === true);
    let frames = [];
    if (lookFurther) {
      const inFrames = await findInFrames(tabId, expression, used);
      frames = inFrames.frames;
      // Only a drawn match beats one hidden in the page; a hidden one in a
      // frame is a last resort, after anything in the page itself.
      // A frame with several drawn matches counts, as its own error: left out,
      // a lone match in another frame would be clicked instead (Codex's review).
      const drawnIn = inFrames.hits.filter((h) => (peek ? h.info.shown : h.info.hidden === false));
      // A peek only asks whether one is showing: hidden ones in several frames
      // are what --reveal is for, not an error before it opens anything.
      const pool = drawnIn.length ? drawnIn : hit.info.none && !peek ? inFrames.hits : [];
      if (pool.length > 1) {
        throw new Error(`in tab ${tabId}, ${what(css, text)} is in ${pool.length} of the page's iframes (${pool.map((h) => `[frame ${h.host}]`).join(', ')}). Snap it and click by ref instead`);
      }
      if (pool.length) hit = pool[0];
    }
    const { info, slot, session, host } = hit;
    if (info.error && !info.none) throw new Error(`in tab ${tabId}, ${host ? `in [frame ${host}], ` : ''}${info.error}`);
    if (peek) return { shown: !!info.shown };
    if (info.none) {
      const also = frames.length ? `, or in any of its ${frames.length} iframe${frames.length > 1 ? 's' : ''} (${frames.slice(0, 6).join(', ')}${frames.length > 6 ? ', …' : ''})` : '';
      throw new Error(`in tab ${tabId}, ${info.error}${also}`);
    }
    const where = host ? ` in [frame ${host}]` : '';
    const backendOf = async (o) => (o?.objectId ? frameNode(session, (await cdp(tabId, 'DOM.describeNode', { objectId: o.objectId }, undefined, session)).node.backendNodeId) : null);
    const node = await backendOf(slot('0'));
    const named = state(tabId).refs.ref(node);
    if (!info.hidden) return { node, ref: named, note: `(${named} is ${info.desc}${where})` };
    // eToro's collapsed side menu (19 Nov): hovering didn't show "Withdraw
    // Funds", but a script click on its link worked. The click goes to what
    // matched and bubbles up to the link around it, which follows it; clicking
    // the link itself would change event.target, which delegated handlers
    // check (Codex's review).
    if (script) return { node, ref: named, hidden: true, note: `(${named} is ${info.desc}${where}, hidden, so it was clicked by script where it is, without showing it)` };
    const revealer = await backendOf(slot('1'));
    if (!revealer) throw new Error(`in tab ${tabId}, ${info.desc}${where} is hidden, and nothing around it is drawn to hover over`);
    const how = await hoverNode(tabId, revealer, sending);
    await sleep(HOVER_MS);
    const { object } = await cdp(tabId, 'DOM.resolveNode', { backendNodeId: node });
    const { result } = await cdp(tabId, 'Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function () { const r = this.getBoundingClientRect(); return r.width > 0 && r.height > 0 && this.checkVisibility({ opacityProperty: true, visibilityProperty: true }); }`,
      returnByValue: true,
    });
    if (!result.value) throw new Error(`in tab ${tabId}, ${info.desc}${where} is hidden, and hovering over ${info.revealer} didn't show it${how ? ` ${how}` : ''}. If it opens on a click (a card or menu that shows its options when clicked), add --reveal "<the text of what opens it>" to click that first, or click it yourself and then this again. Or add --script to click it by script where it is, hidden (as a collapsed side menu's links need)`);
    return { node, ref: named, note: `(${named} is ${info.desc}${where}; it showed once the pointer was over ${info.revealer})` };
  } finally {
    for (const session of used) cdp(tabId, 'Runtime.releaseObjectGroup', { objectGroup: FIND_GROUP }, undefined, session).catch(() => {});
  }
}

const FIND_GROUP = 'browserbear-find';
const what = (css, text) => (css ? `the selector "${css}"` : `the text "${text}"`);

// Runs FIND in the page (doc null) or one of documents()'s frames, keeping
// the elements it found as objects. session is what cdp() is to send their
// commands to: null for the tab's own process, else the cross-origin frame
// whose process the document is in.
async function findIn(tabId, expression, doc, id = null, timeoutMs = CDP_WAIT_MS) {
  const session = doc ? doc.session : null;
  let contextId;
  // One sharing a process with its parent is reached through an isolated
  // world made in it, as evalIn does; a cross-origin one's own main world is
  // its session's default.
  if (doc?.inProcess) contextId = (await cdp(tabId, 'Page.createIsolatedWorld', { frameId: id, worldName: 'browserbear' }, timeoutMs, session)).executionContextId;
  const r = await cdp(tabId, 'Runtime.evaluate', { expression, objectGroup: FIND_GROUP, ...(contextId ? { contextId } : {}) }, timeoutMs, session);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  const { result: props } = await cdp(tabId, 'Runtime.getProperties', { objectId: r.result.objectId, ownProperties: true }, timeoutMs, session);
  const slot = (k) => props.find((p) => p.name === k)?.value;
  return { info: JSON.parse(slot('2').value), slot, session, host: doc ? hostOf(doc.url) || doc.url : null };
}

// FIND in every drawn iframe of the tab. hits: the frames with a match (or
// an error, such as several matches); frames: the hosts of all it looked in,
// for saying where it looked when nothing matched anywhere. A frame that
// doesn't answer in time is left out, as snap leaves it out.
async function findInFrames(tabId, expression, used) {
  const docs = await documents(tabId);
  if (!docs.size) return { hits: [], frames: [] };
  const own = new Map(await Promise.all([...docs].map(async ([id, d]) => [id, await frameShown(tabId, id, d, docs)])));
  // A frame inside a hidden one is hidden too (as read has it).
  const shown = (id) => id === null || !docs.has(id) || (own.get(id) && shown(docs.get(id).parent));
  const looked = [...docs].filter(([id]) => shown(id));
  for (const [, d] of looked) used.add(d.session);
  const results = await Promise.all(looked.map(([id, d]) => findIn(tabId, expression, d, id, PROBE_MS).catch(unlessCutOff)));
  return {
    hits: results.filter((r) => r && !r.info.none),
    frames: [...new Set(looked.map(([, d]) => hostOf(d.url) || d.url))],
  };
}

// Whether a ref's line in the last snapshot was a plain clickable element,
// which may want hovering before it takes a click.
const listedClickable = (tabId, ref) => !!state(tabId).last?.some((l) => l.startsWith(`${ref} clickable`));

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
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  Insert: { code: 'Insert', keyCode: 45 },
  Space: { code: 'Space', keyCode: 32, text: ' ' },
  CapsLock: { code: 'CapsLock', keyCode: 20 },
  NumLock: { code: 'NumLock', keyCode: 144 },
  ScrollLock: { code: 'ScrollLock', keyCode: 145 },
  Pause: { code: 'Pause', keyCode: 19 },
  PrintScreen: { code: 'PrintScreen', keyCode: 44 },
  ContextMenu: { code: 'ContextMenu', keyCode: 93 },
  // A modifier pressed on its own, as some apps want (a double Shift, say).
  Shift: { code: 'ShiftLeft', keyCode: 16 },
  Control: { code: 'ControlLeft', keyCode: 17 },
  Alt: { code: 'AltLeft', keyCode: 18 },
  Meta: { code: 'MetaLeft', keyCode: 91 },
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, { code: `F${i + 1}`, keyCode: 112 + i }])),
};
// Names people write for the keys above, so "Esc" doesn't type "Esc".
const KEY_ALIASES = { Esc: 'Escape', Return: 'Enter', Del: 'Delete', Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight', Cmd: 'Meta', Command: 'Meta', Ctrl: 'Control', Option: 'Alt', Opt: 'Alt' };
const MODS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
// On macOS, Cmd+A and friends sent over CDP don't reach the editor as
// shortcuts (tested on X's composer, 29 Oct); Chrome wants the editing
// command named alongside the key.
const MAC_COMMANDS = { 'Meta+a': 'selectAll', 'Meta+c': 'copy', 'Meta+x': 'cut', 'Meta+v': 'paste', 'Meta+z': 'undo', 'Meta+Shift+z': 'redo' };

// Punctuation's char codes are other keys' key codes: 46, a full stop, is Delete,
// which a page handling its own keydowns takes at its word.
const PUNCTUATION = { '.': ['Period', 190], ',': ['Comma', 188], '-': ['Minus', 189], '=': ['Equal', 187], '/': ['Slash', 191], ';': ['Semicolon', 186], "'": ['Quote', 222], '[': ['BracketLeft', 219], ']': ['BracketRight', 221], '\\': ['Backslash', 220], '`': ['Backquote', 192], ' ': ['Space', 32] };
// The shifted ones, on the key a US keyboard has them on: "+" is Shift and Equal,
// which a shortcut for Control++ checks for.
const SHIFTED = { '!': '1', '@': '2', '#': '3', $: '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0', _: '-', '+': '=', '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/', '~': '`' };
function charKey(key) {
  if (SHIFTED[key]) return { ...charKey(SHIFTED[key]), text: key };
  if (PUNCTUATION[key]) return { code: PUNCTUATION[key][0], keyCode: PUNCTUATION[key][1], text: key };
  if (/^[0-9]$/.test(key)) return { code: `Digit${key}`, keyCode: key.charCodeAt(0), text: key };
  return { code: `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0), text: key };
}

// "Enter", "Meta+a", "Shift+Tab"
async function pressKey(tabId, combo) {
  await cdp(tabId, 'Page.enable');
  // "+" on its own, or as the last key ("Shift++"), is the plus key.
  const parts = combo.endsWith('++') || combo === '+' ? [...combo.slice(0, -2).split('+').filter(Boolean), '+'] : combo.split('+');
  const named = parts.map((p) => KEY_ALIASES[p] || p);
  const key = named.pop();
  const badMod = named.find((p) => !MODS[p]);
  if (badMod) throw new Error(`key: ${JSON.stringify(badMod)} in ${JSON.stringify(combo)} isn't a modifier; use Alt, Control, Meta or Shift`);
  // A name that isn't a key, sent as one, would type its own letters into the
  // field: "End" put "End" into a Google Sheets cell (16 Nov). So only a single
  // character is taken as typing.
  if (!KEYS[key] && [...key].length !== 1) throw new Error(`key: ${JSON.stringify(key)} isn't a key BrowserBear knows. Named keys: ${Object.keys(KEYS).join(', ')}; or a single character, like a or Meta+a. Nothing was pressed`);
  const modifiers = named.reduce((m, p) => m | MODS[p], 0);
  const k = KEYS[key] || charKey(key);
  const ev = { key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers };
  // Text only goes with an unmodified key, or Cmd+A would type an "a". Shift+Enter
  // is the exception: without its text Chrome sends the keydown alone, with no
  // keypress or beforeinput (insertLineBreak), so Slate editors like Discord's never
  // saw a line break (2 Nov).
  const text = !modifiers || (modifiers === MODS.Shift && key === 'Enter') ? k.text : undefined;
  const commands = MAC_COMMANDS[[...named, key].join('+')] ? [MAC_COMMANDS[[...named, key].join('+')]] : undefined;
  // The editing command and the text only work on a full keyDown; rawKeyDown ignores them.
  const type = modifiers && !commands && !text ? 'rawKeyDown' : 'keyDown';
  await cdp(tabId, 'Input.dispatchKeyEvent', { ...ev, type, text, commands });
  await cdp(tabId, 'Input.dispatchKeyEvent', { ...ev, type: 'keyUp' });
}

// Text as real key presses, one character at a time. Not through pressKey, which
// would take a "+" for a combination. Real input is held back on a tab you can't
// see, so an agent's tab comes forward first; your own tabs aren't pulled forward.
// stay: called before each key, to stop once focus leaves the field.
async function typeKeys(tabId, text, stay = null) {
  const p = await ownerOf(tabId);
  const tab = (await call(p, 'tabs')).find((t) => t.tabId === tabId);
  if (!tab?.active && bearTabs.has(tabId)) await call(p, 'show', { tabId });
  for (const key of text) {
    if (stay) await stay();
    const k = charKey(key);
    const ev = { key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode };
    await cdp(tabId, 'Input.dispatchKeyEvent', { ...ev, type: 'keyDown', text: key });
    await cdp(tabId, 'Input.dispatchKeyEvent', { ...ev, type: 'keyUp' });
  }
}

// The field type and --replace mean: the ref if it's editable, otherwise whatever
// has focus (a ref on a wrapper, or no ref), through shadow roots and iframes.
const FIELD = `
  const editable = (e) => e && (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA' || e.isContentEditable);
  let field = editable(this) ? this : document.activeElement;
  while (!editable(this) && (field?.shadowRoot?.activeElement || field?.contentDocument?.activeElement)) field = field.shadowRoot?.activeElement || field.contentDocument.activeElement;
  if (!editable(field)) return null;
  while (field.isContentEditable && field.parentElement?.isContentEditable) field = field.parentElement;`;

// The document focus is in, for type with no ref. FIELD follows focus into
// same-origin frames by itself; a cross-origin one shows only as an <iframe>
// whose document is shut, so it's found by asking each frame (Google payments'
// identity form, 10 Nov: type - said "(no change)").
async function focusedDocument(tabId) {
  const shut = await evaluate(tabId, `(() => {
    let f = document.activeElement;
    while (f?.shadowRoot?.activeElement || f?.contentDocument?.activeElement) f = f.shadowRoot?.activeElement || f.contentDocument.activeElement;
    return f?.tagName === 'IFRAME' && !f.contentDocument;
  })()`).catch(() => false);
  if (shut) {
    const docs = await documents(tabId);
    const focused = new Set();
    await Promise.all([...docs].map(([id, d]) => evalIn(tabId, id, d, 'document.hasFocus()').then((r) => r.result?.value === true && focused.add(id), () => {})));
    // A frame's parents say they have focus too; the one wanted is innermost.
    const id = [...focused].find((f) => ![...focused].some((other) => docs.get(other).parent === f));
    if (id) return (await evalIn(tabId, id, docs.get(id), 'document.documentElement', { timeoutMs: CDP_WAIT_MS, byValue: false })).result;
  }
  return (await cdp(tabId, 'Runtime.evaluate', { expression: 'document.documentElement' })).result;
}

async function onField(tabId, node, body) {
  const target = node ? (await cdp(tabId, 'DOM.resolveNode', { backendNodeId: node })).object : await focusedDocument(tabId);
  const { result } = await cdp(tabId, 'Runtime.callFunctionOn', { objectId: target.objectId, functionDeclaration: `function () {${FIELD}${body}}`, returnByValue: true });
  return result?.value ?? null;
}

// select() works on number inputs, where setSelectionRange throws.
const SELECT_FIELD = `
  field.focus();
  if (field.select) field.select();
  else field.ownerDocument.getSelection().selectAllChildren(field);
  return true;`;
const READ_FIELD = `return { value: field.value ?? field.innerText, rich: field.value === undefined, secret: field.type === 'password' };`;

// The element itself, held on to: a code box can move focus on as soon as it has
// a digit, and the next box being empty doesn't mean the digit was ignored.
async function pinField(tabId, node) {
  const target = node ? (await cdp(tabId, 'DOM.resolveNode', { backendNodeId: node })).object : await focusedDocument(tabId);
  const { result } = await cdp(tabId, 'Runtime.callFunctionOn', { objectId: target.objectId, functionDeclaration: `function () {${FIELD} return field;}` });
  return result?.objectId || null;
}

const readPinned = async (tabId, objectId) =>
  (await cdp(tabId, 'Runtime.callFunctionOn', { objectId, functionDeclaration: `function () { const field = this; ${READ_FIELD} }`, returnByValue: true })).result?.value ?? null;

// A code split across a row of one-character boxes (OpenAI's device page, 5 Nov:
// nine, labelled "Code character 1 of 9"). All of it inserted into the first box
// leaves its first character there and drops the rest. The row runs from the given
// box on, so a code can be started part-way along, and only counts next to
// neighbours of the same shape on the same line. Shape alone isn't enough, since
// spreading text across fields that aren't a code would corrupt them (a row of
// small quantity fields): it takes a one-character limit, which couldn't have held
// the text anyway, or something saying it's a code.
const SPLIT_ROW = `function () {
  if (this.tagName !== 'INPUT') return null;
  const labelOf = (i) => i.getAttribute('aria-label') || i.labels?.[0]?.innerText || i.placeholder || '';
  const wide = (i) => i.getBoundingClientRect().width;
  const top = (i) => i.getBoundingClientRect().top;
  const says = (i) => i.autocomplete === 'one-time-code' || /otp|one.?time|verif|passcode|digit|code/i.test([labelOf(i), i.name, i.id].join(' '));
  const marked = (i) => i.maxLength === 1 || (i.maxLength > 1 ? false : /(character|digit|code)\\b.*\\b\\d+\\s*(of|\\/)\\s*\\d+/i.test(labelOf(i)) || (wide(i) <= 60 && says(i)));
  const inRow = (i) => i && i.type === this.type && Math.abs(wide(i) - wide(this)) <= 2 && Math.abs(top(i) - top(this)) <= 2 && marked(i);
  if (!['text', 'tel', 'number', 'password'].includes(this.type) || !marked(this)) return null;
  const all = [...this.getRootNode().querySelectorAll('input')].filter((i) => i === this || i.checkVisibility());
  const at = all.indexOf(this);
  let first = at, last = at;
  while (inRow(all[first - 1])) first--;
  while (inRow(all[last + 1])) last++;
  return last > first ? all.slice(at, last + 1) : null;
}`;

// The boxes from this field on, or null if it isn't one of a row.
async function splitRow(tabId, node) {
  // Cut off: no answer isn't "not a row", or a whole code would go into its
  // first box once the debugger got back in (Codex's review, 17 Nov 2026).
  const field = await pinField(tabId, node).catch(unlessCutOff);
  if (!field) return null;
  const { result } = await cdp(tabId, 'Runtime.callFunctionOn', { objectId: field, functionDeclaration: SPLIT_ROW });
  if (!result?.objectId) return null;
  const { result: props } = await cdp(tabId, 'Runtime.getProperties', { objectId: result.objectId, ownProperties: true });
  return props.filter((x) => /^\d+$/.test(x.name)).sort((a, b) => a.name - b.name).map((x) => x.value.objectId);
}

// Long enough for a page moving focus along in its own handler to have done it.
const BOX_PAUSE_MS = 80;

// One character per box, into each box by name rather than trusting the page to
// move along, and over what it holds so a retry doesn't need clearing first. Real
// keys for a box that ignores inserted text, as in typeChecked. The last box often
// submits by itself, so this waits for the next page the way a click does. `left`
// says the page has gone, so --submit shouldn't press Enter on whatever's next.
async function typeSplit(tabId, boxes, chars) {
  const total = chars.length;
  const notBoxes = (what) => `type didn't work on tab ${tabId}: that's a code split across ${boxes.length} one-character boxes from this one on, ${what}`;
  if (total > boxes.length) throw new Error(notBoxes(`and it needs ${total} (spaces and dashes don't count). Nothing was typed. Start from the row's first box, or check the code; snap to see`));
  // Focusing a box that's been swapped out does nothing and doesn't fail, so without
  // this check the next character would go into whatever the next screen has focused.
  const select = (box) => cdp(tabId, 'Runtime.callFunctionOn', { objectId: box, functionDeclaration: `function () { if (!this.isConnected || !this.checkVisibility()) return false; this.focus(); this.select(); return true; }`, returnByValue: true }).then((r) => r.result?.value === true, () => false);
  const read = (box) => readPinned(tabId, box).catch(() => null);
  // Held elements stay readable after a single-page app swaps them out, so reading
  // them can't tell that it has moved on to, say, an Authorize screen.
  const here = (box) => cdp(tabId, 'Runtime.callFunctionOn', { objectId: box, functionDeclaration: `function () { return this.isConnected && this.checkVisibility(); }`, returnByValue: true }).then((r) => r.result?.value === true, () => false);
  await markPage(tabId);
  let done = 0;
  for (; done < total; done++) {
    const box = boxes[done];
    const char = chars[done];
    if (!(await select(box))) break; // the page has moved on underneath us
    await cdp(tabId, 'Input.insertText', { text: char });
    await sleep(BOX_PAUSE_MS);
    const held = await read(box);
    if (held && bare(held.value) !== bare(char) && (await select(box))) {
      await typeKeys(tabId, char);
      await sleep(BOX_PAUSE_MS);
    }
  }
  await settleAfterAction(tabId);
  const held = await Promise.all(boxes.slice(0, total).map(read));
  const stayed = await Promise.all(boxes.slice(0, total).map(here));
  if (done < total || held.some((r) => !r) || stayed.includes(false)) return { left: true, note: `(a code split across ${boxes.length} boxes; the page moved on after ${done} of ${total} characters went in, one per box)` };
  const value = held.map((r) => r.value).join('');
  if (bare(value) !== bare(chars.join(''))) throw new Error(notBoxes(`and after filling them one character at a time they hold ${shown({ value, secret: held.some((r) => r.secret) })}, not ${JSON.stringify(chars.join(''))}. Nothing else was pressed, but the page may have read what went in, or cleared them on a code it didn't like; snap to see, and each box can be typed into by its own ref`));
  return { left: false, note: `(a code split across ${boxes.length} boxes, so ${total > 1 ? 'it went in one character per box' : 'that went over what its box held'})` };
}

// Letters and digits, so a page's own commas, currency signs and capitals don't count.
const bare = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const shown = (read) => (read.secret ? "something else (a password field, so it isn't shown)" : JSON.stringify(read.value));

// A field with no size is a canvas app's stand-in for the keyboard: Google Sheets
// keeps its cell editor at top -10000px, 0 wide, until a key press opens the cell.
// Size, not position: a real field scrolled up out of a box has a rect above the
// page too, and must keep type's checks. Such
// an app reads keydowns, and inserted text (which has none) sat in that editor
// unseen while type said it was in, so Enter left the cell empty (16 Nov).
const STAND_IN = `function () {
  const r = this.getBoundingClientRect();
  return r.width < 1 || r.height < 1;
}`;

// Real keys, with line breaks inserted, since a key Enter would commit or send.
async function typeAsKeys(tabId, text) {
  const lines = text.split('\n');
  for (const [i, part] of lines.entries()) {
    if (i) await cdp(tabId, 'Input.insertText', { text: '\n' });
    if (part) await typeKeys(tabId, part);
  }
}

// Plain type's check on what happened. insertText fires the events real typing
// does, which rich editors listen for and setting .value doesn't fire, but a masked
// field can do its own typing from keydown and ignore it (the amount on eToro's
// order panel stayed empty and type said "(no change)", 2 Nov). So a field that
// hasn't changed gets real keys, and one that still hasn't is an error, as is one
// that ends up without the text in it, or with it in twice. Runs before any --submit.
//
// "Hasn't changed" is more than the value staying put, since an editor can show
// inserted text late (Ordinal's Tiptap captions, 5 Nov: it looked unchanged at
// the first read, got the keys as well, and ended up with the caption twice). So
// it waits a while; in a rich editor any change to its DOM counts as taking it;
// and text typed over a selection of the same text changes nothing anyway. Keys
// that did go in get the same wait again, so inserted text turning up even later
// still shows up as a doubled field rather than a success.
//
// A field that really does take the text away (a tag field, on a comma) looks the
// same as one that ignored it, so its text gets typed twice; the note says so.
// Multi-line text is left alone: a composer can send on a line break and empty.
async function typeChecked(tabId, node, text) {
  // Cut off stops the typing rather than leave it unchecked (see splitRow).
  const field = text && !text.includes('\n') ? await pinField(tabId, node).catch(unlessCutOff) : null;
  const standIn = await pinField(tabId, node)
    .then((f) => f && cdp(tabId, 'Runtime.callFunctionOn', { objectId: f, functionDeclaration: STAND_IN, returnByValue: true }))
    .then((r) => r?.result?.value === true, (e) => (unlessCutOff(e), false));
  if (standIn) {
    await typeAsKeys(tabId, text);
    await settle();
    // Nothing to check it against: the app moves its editor, or empties it as it reads.
    return "(the field is hidden, a canvas app's stand-in for the keyboard as in Google Sheets, so that was real key presses; snap or shot to see it landed)";
  }
  const before = field && (await watchField(tabId, field, text).catch(unlessCutOff));
  await cdp(tabId, 'Input.insertText', { text });
  await settle();
  if (!before) return ''; // a canvas editor, say: nothing to read back
  // Gone means the page moved on or redrew the field, which isn't a sign of trouble.
  const read = () => readPinned(tabId, field).catch(unlessStuck);
  let after = await read();
  if (!after) return '';
  // In a rich editor, only the text showing up counts, since a decoration it
  // redraws changes its innerText too.
  const unchanged = async () =>
    before.rich ? times(after.value, text) <= times(before.value, text) && !(await fieldMutated(tabId, field)) : after.value === before.value && !before.noOp;
  const late = async () => {
    for (let waited = 0; waited < LATE_INPUT_MS && (await unchanged()); waited += 150) {
      await sleep(150);
      after = (await read()) || after;
    }
    // The DOM can change between a read and the check on it.
    after = (await read()) || after;
  };
  await late();
  let note = '';
  // A number or email field can't say what was selected: one that holds just
  // the text now was likely all selected and typed over with the same, and
  // keys would put it in twice (Codex's review).
  if (await unchanged() && !(before.unsure && after.value === text)) {
    // With no ref, the field is whatever had focus. If focus has gone somewhere
    // else, the text likely went there, and keys would put it in a second place.
    if (!node && !(await hasFocus(tabId, field))) throw new Error(`type didn't work on tab ${tabId}: the focused field still holds ${shown(before)}, and focus had moved off it, so ${JSON.stringify(text)} may have gone into another field. Nothing else was typed or submitted; snap to see, and type into the field by its ref`);
    if (node) await clickNode(tabId, node);
    await typeKeys(tabId, text);
    await settle();
    after = (await read()) || after;
    if (after.value === before.value) throw new Error(`type didn't work on tab ${tabId}: the field still holds ${before.secret ? 'what it did (a password field, so it isn\'t shown)' : JSON.stringify(before.value)}, so ${JSON.stringify(text)} didn't go in, by inserted text or by real keys. Nothing was submitted. Is it disabled or read-only? snap to see`);
    // The whole wait, not until the first change: the page reformatting what the
    // keys typed isn't the inserted text arriving.
    await sleep(LATE_INPUT_MS);
    after = (await read()) || after;
    note = '(the page ignored inserted text, so that was real key presses)';
  }
  // In, but changed into something else: eToro's SWIFT box (19 Nov), masked as
  // "XXXX AU XXXXX", put its own "AU" in front of inserted "NATAAU3303M" and
  // held "AUNATAAU3303M", which has the text in it, so type said it worked.
  // Keys one at a time went in right, so an empty field is cleared and gets
  // them; one that held something isn't, as clearing it would lose that.
  // Typed over a selection of the same text still has to come out as that text.
  const right = (r) => fits(r.value, before.base, text, r.secret) || (before.unsure && (fits(r.value, '', text, r.secret) || typedOver(r.value, before.base, text)));
  if (!note && !after.rich && !before.base && !right(after) && !doubled(before.base, after.value, text) && (node || (await hasFocus(tabId, field)))) {
    const mangled = after.value;
    if (node) await clickNode(tabId, node);
    const gone = () => new Error(`type went wrong on tab ${tabId}: the page changed ${JSON.stringify(text)} into ${before.secret ? 'something else' : JSON.stringify(mangled)}, and focus left the field while it was being cleared or typed again as keys, so nothing more was typed or submitted. snap to see what it holds, and try browserbear key one character at a time`);
    if (!(await hasFocus(tabId, field))) throw gone();
    await pressKey(tabId, 'Meta+a');
    if (!(await hasFocus(tabId, field))) throw gone();
    await pressKey(tabId, 'Backspace');
    await settle();
    after = (await read()) || after;
    if (after.value) throw new Error(`type went wrong on tab ${tabId}: the page changed ${JSON.stringify(text)} into ${shown({ ...after, value: mangled })}, and clearing it to type it again as keys left ${shown(after)}. Nothing was submitted; snap to see`);
    // Clearing it, or a key (a full field moving on), can send focus to another
    // field, which the rest of the keys would land in.
    await typeKeys(tabId, text, async () => {
      if (!(await hasFocus(tabId, field))) throw gone();
    });
    await settle();
    await sleep(LATE_INPUT_MS);
    after = (await read()) || after;
    note = `(the page changed the inserted text into ${before.secret ? 'something else' : JSON.stringify(mangled)}, so it was cleared and typed again as real key presses)`;
  }
  // One character kept out of several is what a code box does when typeSplit can't
  // see its neighbours (each in a shadow root of its own, say).
  const oneBox = [...after.value].length === 1 && bare(text).length > 1 ? ". If this is a row of one-character boxes, type each character into its own box by its ref" : '';
  if (!norm(text)(after.value).includes(norm(text)(text))) throw new Error(`type didn't work on tab ${tabId}: the field holds ${shown(after)}, which doesn't have ${JSON.stringify(text)} in it. Nothing was submitted. The page may have cut it short or changed it; snap to see${oneBox}`);
  if (doubled(before.base, after.value, text)) throw new Error(`type went wrong on tab ${tabId}: ${JSON.stringify(text)} went in more than once, and the field now holds ${shown(after)}. Nothing was submitted. If the field should hold just that text, browserbear type ${tabId} ${node ? '<ref>' : '-'} ${JSON.stringify(text)} --replace puts it in over what's there`);
  // Only formatting may be added around the text (spaces, commas), not letters
  // or digits of the page's own. A rich editor is left out: its base can't be
  // read as exactly.
  if (!after.rich && !right(after)) throw new Error(`type went wrong on tab ${tabId}: the field holds ${shown(after)}, which isn't ${before.base ? `what it held plus ` : ''}${JSON.stringify(text)}: the page added to it or changed it (a mask's fixed letters, say, an autocomplete, or a sign or separator dropped). Nothing was submitted. snap to see; if it should hold just that text, browserbear type ${tabId} ${node ? '<ref>' : '-'} ${JSON.stringify(text)} --replace puts it in over what's there, and browserbear key types one key at a time`);
  // A rich editor's text isn't in the snapshot, so say what it holds now.
  if (after.rich) note = [note, `(the field now holds ${JSON.stringify(clip(flatten(after.value)))})`].filter(Boolean).join('\n');
  return note;
}

// How much longer than the settle a field gets to show text before it counts as
// ignored, and keys get before their result counts.
const LATE_INPUT_MS = 1500;

// What a field holds before typing, and starts watching a rich editor's DOM for
// the text arriving. noOp: an input whose selection already holds exactly the text.
const watchField = (tabId, field, text) =>
  cdp(tabId, 'Runtime.callFunctionOn', {
    objectId: field,
    functionDeclaration: `function (text) {
      const field = this;
      if (field.isContentEditable) {
        field.__browserbearMutated = false;
        // Only a change that brings the text in counts, not a decoration redrawn.
        const want = (s) => s.toLowerCase().replace(/[^\\p{L}\\p{N}]/gu, '') || s.replace(/\\s+/g, ' ').trim();
        const brings = (n) => want(n.textContent || '').includes(want(text));
        const seen = new MutationObserver((records) => {
          if (!records.some((r) => (r.type === 'characterData' ? brings(r.target) : [...r.addedNodes].some(brings)))) return;
          field.__browserbearMutated = true;
          seen.disconnect();
        });
        seen.observe(field, { subtree: true, childList: true, characterData: true });
        setTimeout(() => seen.disconnect(), 30000);
      }
      // base: what's left once the selection goes, which is what one copy goes into.
      // unsure: an input with no selection to read (number, email), so whatever
      // it held may have been selected and typed over.
      let noOp = false, unsure = false, base = field.value ?? field.innerText;
      try {
        unsure = field.value !== undefined && field.selectionStart === null;
        if (field.value !== undefined && field.selectionStart !== field.selectionEnd) {
          noOp = field.value.slice(field.selectionStart, field.selectionEnd) === text;
          base = field.value.slice(0, field.selectionStart) + field.value.slice(field.selectionEnd);
        }
      } catch { unsure = field.value !== undefined; }
      if (field.value === undefined) {
        const picked = field.ownerDocument.getSelection().toString();
        if (picked.trim() && picked.replace(/\\s+/g, '') === field.innerText.replace(/\\s+/g, '')) base = '';
        else if (picked.trim() && field.contains(field.ownerDocument.getSelection().anchorNode)) base = field.innerText.replace(picked, '');
      }
      ${READ_FIELD.replace('return {', 'return { noOp, unsure, base,')}
    }`,
    arguments: [{ value: text }],
    returnByValue: true,
  }).then((r) => r.result?.value ?? null);

const fieldMutated = (tabId, field) =>
  cdp(tabId, 'Runtime.callFunctionOn', { objectId: field, functionDeclaration: 'function () { return this.__browserbearMutated === true; }', returnByValue: true }).then((r) => r.result?.value === true, () => false);

// Letters and digits, or for text with none (punctuation), the text itself.
const norm = (text) => (bare(text) ? bare : flatten);
const times = (value, text) => {
  const n = norm(text);
  return n(value).split(n(text)).length - 1;
};
// In twice: two more copies than before, and more growth than one copy makes, so
// typing "aba" into "ab|ba" (two copies, overlapping) isn't taken for a double.
// Or grown by exactly two copies' worth with every character of it gained twice
// over, for a late copy arriving in the middle of the keys ("aabcbc"), though not
// a completion ("san" -> "san francisco").
const doubled = (before, after, text) => {
  const n = norm(text);
  const [b, a, t] = [n(before), n(after), n(text)];
  if (times(after, text) - times(before, text) > 1 && a.length - b.length > t.length) return true;
  const count = (s) => [...s].reduce((m, c) => m.set(c, (m.get(c) || 0) + 1), new Map());
  const [cb, ca, ct] = [count(b), count(a), count(t)];
  return t.length > 0 && a.length - b.length === 2 * t.length && [...ct].every(([c, k]) => (ca.get(c) || 0) - (cb.get(c) || 0) >= 2 * k);
};
// Whether value is base with the text put in somewhere, and nothing else
// besides formatting the page added: spaces, commas, dashes, slashes, brackets,
// letter case. Every character typed stays, in its place, so "-100" coming out
// as "100", "1,23" as "123" or "12,3", or "10.00" as "1000", is a different
// amount; and a sign at either end must be the one typed, not one the page
// added (Codex's reviews). A password is compared exactly: its punctuation and
// case are the password.
// A dash the page adds only counts as formatting between two digits or two
// letters ("0412-345"), not as a sign: "$100" coming out as "$-100", or "1e3"
// as "1e-3", is another number (Codex's review).
const FORMATTING = /[\s,\-_/()'’]/;
const formattedFrom = (value, want) => {
  const w = [...want.toLowerCase().replace(/\s+/g, '')];
  const v = [...value.toLowerCase().replace(/\s+/g, '')];
  const kind = (c) => (/\p{N}/u.test(c ?? '') ? 'n' : /\p{L}/u.test(c ?? '') ? 'l' : '');
  let j = 0;
  for (const [i, c] of v.entries()) {
    if (j < w.length && c === w[j]) j++;
    else if (!FORMATTING.test(c)) return false;
    else if (c === '-' && !(kind(v[i - 1]) && kind(v[i - 1]) === kind(v[i + 1]))) return false;
    // A comma or apostrophe the page adds next to a digit groups thousands, so
    // exactly three digits follow: "123" coming out as "1,23" is 1.23 on a page
    // with decimal commas (Codex's review).
    else if (/[,'’]/.test(c) && (kind(v[i - 1]) === 'n' || kind(v[i + 1]) === 'n') && !(kind(v[i - 1]) === 'n' && /^\p{N}{3}(?!\p{N})/u.test(v.slice(i + 1).join('')))) return false;
  }
  return j === w.length;
};
// What a field held is the page's to regroup: "1,234" with 5 typed after it is "12,345".
const ungroup = (s) => s.replace(/[\s,'’_]/g, '');
const sign = (s) => `${/^\s*[-−(+]/.test(s) ? s.trim()[0] : ''}|${/[-−)]\s*$/.test(s) ? s.trim().slice(-1) : ''}`;
const fits = (value, base, text, secret = false) => {
  // Long text: where it went is found from the letters and digits alone.
  if (base.length > 2000) {
    const [a, b, t] = [bare(value), bare(base), bare(text)];
    return a.length === b.length + t.length && [...Array(b.length + 1).keys()].some((i) => a.startsWith(t, i) && a.slice(0, i) + a.slice(i + t.length) === b);
  }
  return Array.from({ length: base.length + 1 }, (_, i) => i).some((i) => {
    const want = base.slice(0, i) + text + base.slice(i);
    return secret ? value === want : sign(value) === sign(want) && formattedFrom(value, ungroup(base.slice(0, i)) + text + ungroup(base.slice(i)));
  });
};
// For a field that can't say what was selected (number, email): value is base
// with some stretch of it, perhaps all, typed over with the text, exactly.
const typedOver = (value, base, text) => {
  if (base.length > 300) return false;
  for (let i = 0; i <= base.length; i++) for (let k = i; k <= base.length; k++) if (value === base.slice(0, i) + text + base.slice(k)) return true;
  return false;
};
const clip = (s) => (s.length > 300 ? `${s.slice(0, 300)}…` : s);

// Whether focus is still in this field, through shadow roots and iframes.
const hasFocus = (tabId, field) =>
  cdp(tabId, 'Runtime.callFunctionOn', {
    objectId: field,
    functionDeclaration: `function () {
      let f = document.activeElement;
      while (f?.shadowRoot?.activeElement || f?.contentDocument?.activeElement) f = f.shadowRoot?.activeElement || f.contentDocument.activeElement;
      return !!f && (f === this || this.contains(f));
    }`,
    returnByValue: true,
  }).then((r) => r.result?.value === true, () => true);

// Rich editors wrap text in their own paragraphs, so only the words count there.
const flatten = (s) => s.replace(/\s+/g, ' ').trim();
const holds = (read, text) => (read.rich ? flatten(read.value) === flatten(text) : read.value === text);

// Types over what the field holds. Clearing first and typing after doesn't work
// everywhere: a controlled field can put its old value straight back once it's
// empty, so the new text lands after it ("stocks-clistocks cli" on Webull's API
// key form, 1 Nov). So the text goes in over a selection, as a single edit. The
// keys are the fallback, with a pause before typing since those pages can take a
// moment to redraw. Pages can still change what they're given (an amount
// re-derived from its state on BTC Markets, 30 Oct), so the field is read back,
// and a field that doesn't hold exactly the text is a failure. Runs before any
// --submit, so a wrong value doesn't get sent.
async function replaceText(tabId, node, text) {
  const insert = () => (text ? cdp(tabId, 'Input.insertText', { text }) : pressKey(tabId, 'Backspace'));
  // Formatting the page adds (eToro's SWIFT box grouping it, "ANZB AU 3M") is fine.
  const took = (r) => holds(r, text) || (!r.rich && fits(r.value, '', text, r.secret));
  // The field it starts in, held on to: with -, a read follows focus, which a
  // page can move on (Codex's review).
  const field = text ? await pinField(tabId, node).catch(unlessCutOff) : null;
  if (await onField(tabId, node, SELECT_FIELD).catch(() => null)) {
    await insert();
    await settle();
    // Given a moment, as in typeChecked: an editor that shows it late would
    // otherwise get it again below, and end up with it twice.
    let read = await onField(tabId, node, READ_FIELD);
    for (let waited = 0; read && !took(read) && waited < LATE_INPUT_MS; waited += 150) {
      await sleep(150);
      read = await onField(tabId, node, READ_FIELD);
    }
    if (read && took(read)) return '';
  }
  if (node) await clickNode(tabId, node);
  await pressKey(tabId, 'Meta+a');
  await pressKey(tabId, 'Backspace');
  await settle();
  const cleared = await onField(tabId, node, READ_FIELD);
  if (text) await cdp(tabId, 'Input.insertText', { text });
  await settle();
  let read = await onField(tabId, node, READ_FIELD);
  // Ignored the inserted text, as a masked field does, or changed it, as
  // eToro's SWIFT box did (see typeChecked): then real keys.
  if (text && read && (read.value === cleared?.value || (!read.rich && !fits(read.value, '', text, read.secret)))) {
    // Held on to, and checked for focus around the clearing: a page that moves
    // focus on would get the keys in another field, and -'s read would follow it
    // there and call it done (Codex's review).
    const astray = () => new Error(`--replace went wrong on tab ${tabId}: the page changed the inserted text into ${shown(read)}, and focus left the field while it was being cleared or typed again as keys, so nothing more was typed or submitted. snap to see what it holds, and try browserbear key one character at a time`);
    if (field && !(await hasFocus(tabId, field))) throw astray();
    if (read.value !== cleared?.value) {
      await pressKey(tabId, 'Meta+a');
      if (field && !(await hasFocus(tabId, field))) throw astray();
      await pressKey(tabId, 'Backspace');
      await settle();
      const now = field ? await readPinned(tabId, field).catch(unlessStuck) : null;
      if (field && !(await hasFocus(tabId, field))) throw astray();
      if (now?.value) throw new Error(`--replace went wrong on tab ${tabId}: the page changed the inserted text into ${shown(read)}, and clearing it to type again as keys left ${shown(now)}. Nothing was submitted; snap to see`);
    }
    await typeKeys(tabId, text, async () => {
      if (field && !(await hasFocus(tabId, field))) throw astray();
    });
    await settle();
    read = await onField(tabId, node, READ_FIELD);
  }
  // A canvas editor (Google Docs) has no field to read back.
  if (!read) return "(this editor can't be read back, so check below that the text was replaced)";
  // Still holding it a moment later: the first attempt's text turning up late
  // would land on top of this one.
  if (took(read)) {
    await sleep(LATE_INPUT_MS);
    read = (await onField(tabId, node, READ_FIELD)) || read;
  }
  if (took(read)) return '';
  throw new Error(`--replace didn't work on tab ${tabId}: the field holds ${shown(read)}, not ${JSON.stringify(text)}. Nothing was submitted. The page may have changed or reformatted it; snap to see`);
}

// download's chunks: well under Chrome's 64 MB limit on a message to the host
// once they're base64.
const DOWNLOAD_CHUNK = 4 * 1024 * 1024;

// Runs in an isolated world in the tab's top frame: the page's origin and
// cookies, but the browser's own fetch and URL, and globals the page can't
// see. In the page's own world a site could swap fetch out and hand over
// bytes of its choosing for another site's URL (Codex review, 16 Nov).
async function isolatedIn(tab) {
  const { frameTree } = await cdp(tab, 'Page.getFrameTree');
  const { executionContextId } = await cdp(tab, 'Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'browserbear-download' });
  return async (expression, timeoutMs) => {
    const r = await cdp(tab, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, contextId: executionContextId }, timeoutMs);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
}

// The isolated world keeps the bytes until they've all been read. The fetch
// gets as long as the extension's would.
async function fetchInPage(run, url) {
  // Chrome hands back the same isolated world for the same name, so each
  // download keeps its bytes under a name of its own.
  const k = JSON.stringify(`download-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const f = await run(`(async () => {
    const r = await fetch(${JSON.stringify(url)}, { credentials: 'include' });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + r.statusText + ' from ' + (r.url || ${JSON.stringify(url)}));
    const bytes = (globalThis[${k}] = new Uint8Array(await r.arrayBuffer()));
    return { size: bytes.length, type: r.headers.get('content-type'), disposition: r.headers.get('content-disposition'), url: r.url };
  })()`, 130_000);
  const chunk = (offset, length) =>
    run(`(() => {
      const all = globalThis[${k}];
      if (!all) throw new Error('the page lost the download (did it navigate?)');
      const bytes = all.subarray(${offset}, ${offset} + ${length});
      if (${offset} + ${length} >= all.length) delete globalThis[${k}];
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(bin);
    })()`);
  return { ...f, chunk };
}

// The name the agent gave, else the server's (Content-Disposition), else the
// URL's last part. Only ever a bare name, so it can't climb out of the folder.
function fileNameFor(given, disposition, url) {
  let name = given;
  if (!name && disposition) {
    const star = disposition.match(/filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i);
    const plain = disposition.match(/filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)/i);
    try {
      name = star ? decodeURIComponent(star[2].trim()) : plain && (plain[1] ?? plain[2].trim());
    } catch {
      name = plain && (plain[1] ?? plain[2].trim());
    }
  }
  if (!name) {
    try {
      name = decodeURIComponent(new URL(url).pathname.split('/').pop());
    } catch {}
  }
  name = String(name || '').split(/[\\/]/).pop().replace(/[\x00-\x1f:]/g, '_').trim();
  if (!name || name === '.' || name === '..') return 'download';
  // macOS takes 255 bytes a name; keep the extension when cutting it down.
  if (Buffer.byteLength(name) > 200) {
    const ext = path.extname(name).slice(0, 20);
    let stem = name.slice(0, name.length - ext.length);
    while (Buffer.byteLength(stem + ext) > 200) stem = [...stem].slice(0, -1).join('');
    name = stem + ext;
  }
  return name;
}

async function evaluate(tabId, expression) {
  const r = await cdp(tabId, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

// For the waits on a page to load: a refusal, a closed tab or a stuck page
// won't get better by trying again.
const unlessRefused = (e) => {
  if (e.refused || e.closed || e.stuck || e.cutOff) throw e;
  return null;
};
// A frame that can't be looked at is left out, but not one BrowserBear was
// cut off from: snap and read would quietly come back without it.
const unlessCutOff = (e) => {
  if (e.cutOff) throw e;
  return null;
};
// For the looks that are only nice to have (is it drawn yet?): anything but a
// stuck page is shrugged off.
const unlessStuck = (e) => {
  if (e.stuck || e.cutOff) throw e;
  return null;
};

async function waitForReady(tabId, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const ready = await evaluate(tabId, 'document.readyState').catch(unlessRefused);
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
    ? `\n(this looks like a sign-in page, in a window the user may not be looking at. If they have to sign in: browserbear handoff ${tabId} --wait)`
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
  const only = agentOnlyOn();
  for (const [tabId, pages] of sentTo) if (pages.has(want) && profiles.has(tabOwner.get(tabId)) && (!only || tabOwner.get(tabId) === AGENT_INSTANCE)) return tabId;
  const lists = await Promise.all(
    [...profiles.values()].filter((p) => !only || p.instance === AGENT_INSTANCE).map((p) => call(p, 'tabs').then((tabs) => tabs.map((t) => remember(p.instance, t)), () => [])),
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
  // Agent-only: one of Mike's tabs with the same id mustn't take it over.
  if (agentOnlyOn() && instance !== AGENT_INSTANCE && tabOwner.get(tab.tabId) === AGENT_INSTANCE) return tab;
  tabOwner.set(tab.tabId, instance);
  return tab;
};

// Sign in from 1Password (onepassword.mjs): whatever of username, password
// and one-time code the page is asking for now, so a two-step sign-in
// (Google's email page, then its password page) takes a fill on each. The
// values go from 1Password into the page and nowhere else: what comes back
// is which login and which fields, nothing the page wrote. Until the tab
// loads another page, eval, cdp and secret are refused there and snapshots hide the
// filled fields, so the values can't be read back either.
async function fillIn({ tab, item, submit }) {
  if ((await ownerOf(tab)).instance !== AGENT_INSTANCE) throw new Error(`fill only signs in in the agent's own Chrome (--profile agent), not tab ${tab}`);
  await cdp(tab, 'Page.enable');
  const { frameTree } = await cdp(tab, 'Page.getFrameTree');
  const startUrl = frameTree.frame.url;
  const { executionContextId } = await cdp(tab, 'Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'browserbear-fill' });
  const { result: doc } = await cdp(tab, 'Runtime.evaluate', { expression: 'document', contextId: executionContextId });
  const { result: found } = await cdp(tab, 'Runtime.callFunctionOn', { objectId: doc.objectId, functionDeclaration: FIND_LOGIN_FIELDS, returnByValue: false });
  const props = Object.fromEntries((await cdp(tab, 'Runtime.getProperties', { objectId: found.objectId, ownProperties: true })).result.map((x) => [x.name, x.value]));
  const field = (name) => (props[name]?.subtype === 'node' ? props[name].objectId : null);
  const fields = { user: field('user'), password: field('password'), otp: field('otp') };
  if (!fields.user && !fields.password && !fields.otp) {
    throw new Error(`tab ${tab} has no sign-in field fill can see (it doesn't reach into frames). Snap it, or hand it to the user: browserbear handoff ${tab} --wait`);
  }
  if (fields.otp && props.splitCode?.value) {
    throw new Error(`tab ${tab} wants a one-time code split across several boxes, which fill doesn't type. Hand it to the user: browserbear handoff ${tab} --wait`);
  }
  const logins = await loginsFor(startUrl);
  const login = pickLogin(logins, item, startUrl);
  const secret = await secretsFor(login.id, { otp: Boolean(fields.otp) });
  if (fields.otp && !secret.hasOtp) {
    throw new Error(`the page wants a one-time code, but "${login.title}" in 1Password has none. Hand it to the user: browserbear handoff ${tab} --wait`);
  }
  const filled = [];
  const backendIds = [];
  // On disk before anything's typed: a service restarted after typing, with
  // nothing saved, would let eval or secret read it back (Codex's review).
  const hadRecord = filledTabs.has(tab);
  if (!protectFilled(tab, frameTree.frame.loaderId, [])) {
    throw new Error(`fill can't keep track of what it types (${FILLED} couldn't be saved), so it didn't type anything. Hand the sign-in to the user: browserbear handoff ${tab} --wait`);
  }
  try {
    for (const [which, value, label] of [['user', secret.username, 'username'], ['password', secret.password, 'password'], ['otp', secret.otp, 'one-time code']]) {
      if (!fields[which] || !value) continue;
      // Approving in 1Password takes a while; the tab may have gone
      // somewhere else meanwhile, and a login only goes to its own site.
      backendIds.push((await cdp(tab, 'DOM.describeNode', { objectId: fields[which] })).node.backendNodeId);
      // Saved before it's typed, so snap masks it even in a service restarted mid-fill.
      if (!protectFilled(tab, frameTree.frame.loaderId, backendIds)) throw new FillStopped(`${FILLED} couldn't be saved, so it stopped before typing the ${label}`);
      const put = (await cdp(tab, 'Runtime.callFunctionOn', { objectId: fields[which], functionDeclaration: PUT_FIELD, arguments: [{ value }, { value: allowedFor(login) }], returnByValue: true })).result?.value;
      if (put === 'site') throw new FillStopped(`the tab is no longer on a site "${login.title}" is saved for`);
      // X keeps a hidden password box on its username step that goes once
      // the username's in: what's typed so far is the step, not a failure.
      if (put !== 'ok' && filled.length) break;
      if (put !== 'ok') throw new FillStopped(`the page changed before fill could type the ${label}`);
      filled.push(label);
    }
  } catch (e) {
    // Whatever the page did meanwhile (a dialog, say) can carry what was
    // typed, so only fill's own words go back.
    throw e instanceof FillStopped ? new Error(`fill stopped: ${e.message}${filled.length ? ` (after the ${filled.join(', ')})` : ''}. Snap tab ${tab} to see where it is`) : new Error(`fill stopped in tab ${tab}${filled.length ? ` after the ${filled.join(', ')}` : ''}: the page changed or showed a dialog. Snap it to see where it is`);
  } finally {
    // The page as it is after typing: one that loaded in the meantime is
    // the one holding the values.
    if (backendIds.length) {
      const loaderId = await cdp(tab, 'Page.getFrameTree').then((r) => r.frameTree.frame.loaderId, () => frameTree.frame.loaderId);
      protectFilled(tab, loaderId, backendIds);
    } else if (!hadRecord) {
      // Nothing typed: the page needn't stay locked.
      filledTabs.delete(tab);
      saveFilled();
    }
  }
  if (!filled.length) throw new Error(`"${login.title}" in 1Password has nothing for the fields on this page`);
  if (submit) {
    await markPage(tab);
    await pressKey(tab, 'Enter').catch(() => {});
    await settleAfterAction(tab).catch(() => {});
  }
  return `filled the ${filled.join(', ')} from 1Password ("${login.title}") in tab ${tab}${submit ? ' and pressed Enter' : "; press the page's sign-in button (or run fill again with --submit)"}. Snap it to see the next step.`;
}

const commands = {
  async status() {
    return { pid: process.pid, socket: SOCKET, profiles: [...profiles.values()].map(describe) };
  },

  panelState: () => panel.state(),

  async profiles() {
    const connected = [...profiles.values()];
    const known = chromeProfiles();
    if (!known) {
      // Chrome's Profiles menu still says which profiles exist.
      const menu = await menuProfiles();
      const names = Array.isArray(menu) ? menu : [];
      learnNames(names);
      const unmatched = names.filter((n) => !connected.some((p) => p.menuName === n));
      return [
        ...connected.map((p) => `● ${describe(p)}`),
        ...unmatched.map((n) => `○ ${n}`),
        unmatched.length
          ? `(○ is in Chrome's Profiles menu but not matched to a connected profile: BrowserBear only learns a connected profile's email, so it may be one of the ● above. \`--profile "<name>"\` opens it.)`
          : Array.isArray(menu) ? null : `(BrowserBear couldn't read Chrome's Profiles menu: ${menu.error}. \`--profile <email>\` still opens a profile that isn't connected.)`,
        `(${NO_NAMES})`,
      ].filter(Boolean).join('\n');
    }
    return known.map((p) => {
      const c = connected.find((x) => x.email && x.email === p.email);
      return `${c ? '●' : '○'} ${p.name} (${p.email || 'not signed in'}, ${p.dir})${c ? '' : ': extension not connected'}`;
    }).join('\n');
  },

  async tabs({ profile }) {
    const list = profile ? [await findProfile(profile)] : [...profiles.values()];
    const out = [];
    const seen = new Set();
    for (const p of list) {
      out.push(`${describe(p)}:`);
      for (const t of await call(p, 'tabs')) {
        seen.add(t.tabId);
        remember(p.instance, t);
        // So an agent can tell its own tab from the user's on the same page.
        const user = handed.has(t.tabId) || (t.agent && t.bear === false) ? ' (handed to the user)' : t.agent === false && !claimed.has(t.tabId) ? " (the user's)" : '';
        out.push(`  ${t.tabId}${t.active ? '*' : ' '} ${redact(t.title).slice(0, 60)} <${redact(t.url).slice(0, 100)}>${user}${marks.label(t.tabId)}`);
      }
    }
    // Handoffs of tabs that have since closed, so a later tab given the same id
    // (Chrome starts them again after a restart) isn't taken for one.
    if (!profile) for (const id of handed) if (!seen.has(id)) setHanded(id, false);
    return out.join('\n');
  },

  // Long enough for the agents' browser to restart itself first, when it has
  // updated underneath itself (agent/agent-host.mjs).
  async open({ profile, url, thread }) {
    const p = await findProfile(profile);
    const tab = remember(p.instance, await call(p, 'open', { url, thread }, OPEN_OP_MS));
    panel.remember(tab.tabId, thread, p.instance, true);
    marks.used(tab.tabId, thread, `opening ${hostOf(url)}`);
    bearTabs.add(tab.tabId);
    sent(tab.tabId, url);
    // The agent still needs the tab's id to get out of a page that failed.
    const failure = loadFailure(tab);
    if (failure) throw new Error(`opened tab ${tab.tabId} in ${describe(p)}, but: ${failure}. ${wayOut(tab.tabId)}`);
    // Whatever goes wrong from here, the tab is open: an agent that only sees
    // the error thinks the open failed, and opens another (BTC Markets, 1 Nov).
    try {
      await wake(tab.tabId);
      await drawn(tab.tabId);
      const snap = await snapshot(tab.tabId);
      const where = p.instance === AGENT_INSTANCE ? `the agents' browser (${p.browser || 'Helium'}), in a window behind the user's` : `${describe(p)}, in BrowserBear's own window`;
      return `opened tab ${tab.tabId} in ${where}\n${snap}${await handoffHint(tab.tabId)}`;
    } catch (e) {
      e.message = `opened tab ${tab.tabId} in ${describe(p)}, but couldn't look at it yet: ${e.message}`;
      throw e;
    }
  },

  // Find one of Mike's own tabs by a bit of its URL or title.
  // Or by its id, to take on a tab the user asked an agent to work in.
  async claim({ match, profile, thread }) {
    const list = profile ? [await findProfile(profile)] : [...profiles.values()];
    const hits = [];
    for (const p of list) {
      for (const t of await call(p, 'tabs')) {
        remember(p.instance, t);
        if (String(t.tabId) === match.trim() || `${t.url} ${t.title}`.toLowerCase().includes(match.toLowerCase())) hits.push({ p, t });
      }
    }
    if (!hits.length) throw new Error(`no open tab matches "${match}"`);
    if (hits.length > 1) {
      return `several tabs match; pick one by id:\n${hits.map(({ p, t }) => `  ${t.tabId} [${describe(p)}] ${redact(t.title).slice(0, 60)} <${redact(t.url).slice(0, 100)}>`).join('\n')}`;
    }
    claimed.add(hits[0].t.tabId);
    // Before the snapshot, which stops short at a JS dialog: a tab an agent
    // woke and the user then dragged out is theirs now (Codex's review).
    await unlessAgents(hits[0].t.tabId, { who: 'claimed', t: hits[0].t });
    marks.used(hits[0].t.tabId, thread, 'looking at the page');
    panel.remember(hits[0].t.tabId, thread, hits[0].p.instance);
    return snapshot(hits[0].t.tabId);
  },

  snap: ({ tab, full }) => snapshot(tab, { full }),

  click: ({ tab, ref: given, css, text, nth, script, reveal }) =>
    orClosed(tab, async (sending) => {
      const before = state(tab).last;
      const startUrl = (await tabNow(tab))?.url;
      // --reveal: click what opens it first, for a menu that shows its options
      // on a click rather than a hover (Zoho's "Import/Upload HTML" card, whose
      // "Upload from Computer" sits hidden elsewhere in the page, 17 Nov).
      // Not when it's showing already: the click could shut it again.
      let opened = '';
      if (reveal !== undefined) {
        if (typeof reveal !== 'string' || !reveal) throw new Error('--reveal needs the text of what opens it');
        // A ref is something snap saw, so it's showing; and a peek can't tell.
        if (given && isRef(given) && !css && !text) throw new Error('--reveal goes with --text or --css: a ref is from something snap saw, so it is showing already');
        // Only when there's no drawn match at all. Two showing, or a bad
        // selector, is an error before anything's clicked (Codex's review).
        if (!(await resolveTarget(tab, { ref: given, css, text, nth, peek: true })).shown) {
          const opener = await resolveTarget(tab, { text: reveal }, sending);
          const was = (await tabNow(tab))?.url;
          await markPage(tab);
          const how = await clickNode(tab, opener.node, { script, hover: true, sending });
          await settleAfterAction(tab);
          // Gone to another page: what matches there isn't what was meant.
          const mark = await evaluate(tab, 'window.__browserbear ?? null').catch(() => null);
          if (mark !== 'here' || (await tabNow(tab))?.url !== was) {
            throw new Error(`clicking ${opener.ref} to show it went to another page, so nothing more was clicked. ${opener.note}\n${await snapshot(tab)}`);
          }
          opened = [`(clicked ${opener.ref} first to show it: ${opener.note.replace(/^\(\S+ is |\)$/g, '')})`, how].filter(Boolean).join('\n');
        }
      }
      const found = await resolveTarget(tab, { ref: given, css, text, nth, script }, sending);
      const { node, ref } = found;
      // Found by --css or --text, or listed as a plain clickable: a <div> may
      // only take clicks once it's hovered, as the user's mouse would have.
      // Not a hidden one clicked by script: hovering could make its menu redraw it.
      const hover = !(script && found.hidden) && (!!(css || text || !isRef(given)) || listedClickable(tab, ref));
      await markPage(tab);
      const note = [opened, found.note, await clickNode(tab, node, { script, hover, sending })].filter(Boolean).join('\n');
      await settleAfterAction(tab);
      let out = await snapshot(tab);
      // A new address counts by itself: history.pushState can leave every control as it was.
      const stayedPut = async () => sameApartFromFocus(before, state(tab).last) && (await tabNow(tab))?.url === startUrl;
      let same = await stayedPut();
      if (same && (await isButton(tab, node).catch(() => false))) {
        await markPage(tab);
        await lateEffect(tab);
        const later = await snapshot(tab);
        same = await stayedPut();
        if (!same) out = later;
      }
      const unchanged = !script && same;
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
    }),

  hover: ({ tab, ref: given, css, text, nth }) =>
    orClosed(tab, async (sending) => {
      const found = await resolveTarget(tab, { ref: given, css, text, nth }, sending);
      await markPage(tab);
      const note = [found.note, await hoverNode(tab, found.node, sending)].filter(Boolean).join('\n');
      await sleep(HOVER_MS);
      await settleAfterAction(tab);
      return (note ? note + '\n' : '') + (await snapshot(tab));
    }),

  type: ({ tab, ref, text, submit, replace }) =>
    orClosed(tab, async (sending) => {
      if (ref) {
        const node = await nodeFor(tab, ref);
        await cdp(tab, 'DOM.focus', { backendNodeId: node }).catch(() => clickNode(tab, node));
      }
      const node = ref ? await nodeFor(tab, ref) : null;
      // Separators are on the page between the boxes, not in them. Before --replace
      // too: its check that the field holds exactly the text can't pass on one box.
      const chars = text.includes('\n') ? [] : [...text.replace(/[\s-]/g, '')];
      // One character too: a full box won't take it any other way.
      const boxes = chars.length ? await splitRow(tab, node).catch(unlessCutOff) : null;
      sending();
      const { note, left } = boxes ? await typeSplit(tab, boxes, chars) : { note: replace ? await replaceText(tab, node, text) : await typeChecked(tab, node, text) };
      if (submit && !left) {
        await markPage(tab);
        await pressKey(tab, 'Enter');
        await settleAfterAction(tab);
      }
      return (note ? note + '\n' : '') + (await snapshot(tab));
    }),

  key: ({ tab, key }) =>
    orClosed(tab, async (sending) => {
      await markPage(tab);
      await cdp(tab, 'Page.enable');
      sending();
      await pressKey(tab, key);
      await settleAfterAction(tab);
      return snapshot(tab);
    }),

  async goto({ tab, url }) {
    const p = await ownerOf(tab);
    try {
      // Page events (the leave-site dialog among them) only arrive once enabled.
      await cdp(tab, 'Page.enable');
      await cdp(tab, 'Page.navigate', { url });
    } catch (e) {
      if (!e.refused) throw e;
      await call(p, 'navigate', { tabId: tab, url }, 40_000).catch((e) => {
        if (/unknown op/.test(e.message)) throw new Error(`${describe(p)} has an older BrowserBear extension, which can't leave Chrome's warning pages; browserbear reload, then try again`);
        throw e;
      });
    }
    sent(tab, url);
    // Refused here means it landed on a warning page, explained just below.
    await waitForReady(tab).catch(unlessStuck);
    await wake(tab);
    await drawn(tab);
    const failure = loadFailure((await call(p, 'tabs')).find((t) => t.tabId === tab));
    if (failure) throw new Error(`${failure}. ${wayOut(tab)}`);
    return (await snapshot(tab)) + (await handoffHint(tab));
  },

  // The page's text, for reading rather than acting. Long pages go to a file.
  // Sign in from 1Password: see fillIn.
  async fill(args) {
    fillingTabs.add(args.tab);
    fillCount.set(args.tab, (fillCount.get(args.tab) || 0) + 1);
    try {
      return await fillIn(args);
    } finally {
      fillingTabs.delete(args.tab);
    }
  },

  // A key or token shown in the page, for the CLI to write to a file (cli.mjs,
  // writeSecret), so it never goes through the agent's output. Inside frames
  // too: AI Studio's key is in the Cloud console's, where eval can't see
  // (19 Nov). The value goes back to the CLI only.
  async secret({ tab, ref, css, text, nth }) {
    // script: a hidden match is taken where it is, without hovering. Its
    // notes and errors quote what the element says, which is the key, so
    // they're left out or have their quotes emptied.
    // The arguments are checked here, so that every error from finding it
    // can be one of these fixed ones: the page can put words in any other
    // (Codex's review).
    if (css === true || text === true) throw new Error(`--${css === true ? 'css' : 'text'} needs a value`);
    if (nth !== undefined && !(Number.isInteger(nth) && nth > 0)) throw new Error('--nth takes a number from 1');
    if (!ref && !css && !text) throw new Error('say what holds the key: a ref from browserbear snap (e12), --css <selector> or --text <text>');
    if (ref && isRef(ref) && !css && !text) await nodeFor(tab, ref);
    const found = await resolveTarget(tab, { ref, css, text, nth, script: true }, () => {}).catch((e) => {
      const several = /^in tab \d+, .* matches (\d+)/.exec(e.message)?.[1];
      if (several) throw new Error(`in tab ${tab}, that matches several elements; snap it and give the ref, or add --nth`);
      throw new Error(`in tab ${tab}, that couldn't be picked out as one element (nothing matched, or the page got in the way); snap it and give the ref`);
    });
    // Nor any error from reading it: a page's own (a dialog it opens, a value
    // getter that throws) can say anything (Codex's review).
    const result = await (async () => {
      const { object } = await cdp(tab, 'DOM.resolveNode', { backendNodeId: found.node });
      return (await cdp(tab, 'Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: READ_SECRET, returnByValue: true })).result;
    })().catch(() => {
      throw new Error(`in tab ${tab}, that element couldn't be read (the page may have changed, or opened a dialog); snap it to see`);
    });
    const value = typeof result?.value === 'string' ? result.value.trim() : '';
    if (!value) throw new Error(`${found.ref || 'that'} in tab ${tab} is empty, so nothing was written. A key a page hides until "Show key" is clicked needs that first`);
    if (/\s/.test(value)) throw new Error(`${found.ref || 'that'} in tab ${tab} holds more than one word, so it isn't just the key and nothing was written. Point at the field or element with the key alone`);
    return { secret: value };
  },

  async read({ tab, max = 4000 }) {
    // Straight after a click that navigates, there may be no body yet, or no
    // page to evaluate in at all (passport.service.gov.uk, 30 Oct): wait for
    // one rather than fail.
    await waitForReady(tab, 10_000);
    await wake(tab);
    await drawn(tab);
    let text = null;
    for (let i = 0; i < 20 && typeof text !== 'string'; i++) {
      if (i) await sleep(250);
      text = await evaluate(tab, 'document.body?.innerText ?? null').catch(unlessRefused);
    }
    if (typeof text !== 'string') throw new Error(`tab ${tab} has no page to read yet; try again in a moment`);
    // innerText stops at an iframe, so each one is read by itself (a
    // same-origin one too, which the page's innerText doesn't include either).
    const docs = await documents(tab);
    const frames = [...docs];
    // A frame inside a hidden one is hidden too, though its own iframe looks
    // fine from inside the hidden document (Codex's review, 11 Nov).
    const own = new Map(await Promise.all(frames.map(async ([id, d]) => [id, await frameShown(tab, id, d, docs)])));
    const shown = (id) => id === null || !docs.has(id) || (own.get(id) && shown(docs.get(id).parent));
    const inner = await Promise.all(frames.map(([id, d]) => (shown(id) ? evalIn(tab, id, d, FRAME_TEXT).then((r) => r.result?.value, (e) => (unlessCutOff(e), '')) : '')));
    frames.forEach(([, f], i) => {
      if (typeof inner[i] === 'string' && inner[i].trim()) text += `\n\n[frame ${hostOf(f.url) || f.url}]\n${inner[i]}`;
    });
    // Before it's cut, so a key at the cut isn't left half shown.
    text = redact(text);
    if (text.length <= max) return text;
    const file = path.join(OUT, `tab-${tab}-${Date.now()}.txt`);
    fs.writeFileSync(file, text, { mode: 0o600 });
    return `${text.slice(0, max)}\n… ${text.length - max} more characters in ${file}`;
  },

  async shot({ tab, file }) {
    await wake(tab);
    const { data } = await cdp(tab, 'Page.captureScreenshot', { format: 'png' });
    file ||= path.join(OUT, `tab-${tab}-${Date.now()}.png`);
    fs.writeFileSync(file, Buffer.from(data, 'base64'), { mode: 0o600 });
    return file;
  },

  // No wake here: its look first would hide a stuck session from the eval.
  // goto, snap and read have already woken the page, and it stays awake for
  // as long as the session does.
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

  // Saves the file into BrowserBear's own folder, never ~/Downloads: macOS
  // keeps agents out of that, so a path there was no use to them.
  async download({ tab, url, filename }) {
    if (!url) throw new Error('say which URL to download');
    const p = await ownerOf(tab);
    let run;
    const isolated = async () => (run ||= await isolatedIn(tab));
    // A relative link is relative to the page it's on.
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = await (await isolated())(`new URL(${JSON.stringify(url)}, document.baseURI).href`);
    let got;
    try {
      const f = await call(p, 'fetchFile', { url }, 130_000);
      got = { ...f, chunk: (offset, length) => call(p, 'fetchChunk', { id: f.id, offset, length }, 60_000) };
    } catch (e) {
      // The agents' browser has no fetchFile, nor has an extension that
      // hasn't reloaded since it came in: fetch from inside the page instead,
      // which has the page's cookies but not a way round CORS.
      if (!/unknown op fetchFile/.test(e.message)) throw e;
      got = await fetchInPage(await isolated(), url);
    }
    const name = fileNameFor(filename, got.disposition, got.url || url);
    // A folder of its own each time, so two downloads of one name can't meet.
    fs.mkdirSync(path.join(OUT, 'downloads'), { recursive: true, mode: 0o700 });
    const dir = fs.mkdtempSync(path.join(OUT, 'downloads', `${Date.now()}-${tab}-`));
    const file = path.join(dir, name);
    const fd = fs.openSync(file, 'wx', 0o600);
    try {
      for (let offset = 0; offset < got.size; offset += DOWNLOAD_CHUNK) {
        fs.writeSync(fd, Buffer.from(await got.chunk(offset, DOWNLOAD_CHUNK), 'base64'));
      }
    } finally {
      fs.closeSync(fd);
    }
    return { path: file, bytes: got.size, type: got.type || null };
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
    return `tab ${tab} is at the front of BrowserBear's window, which the user may not be looking at. To have them do something in it: browserbear handoff ${tab} --wait`;
  },

  // Gives a tab to the user: its real window comes to the front, in their own
  // Chrome or in the agents' browser (Helium). Given a URL rather than an id, it finds the agent tab already on that
  // page (Threadbear does this for the link buttons on an agent's asks, so
  // you don't get a second tab of the same page).
  // With `wait` the CLI goes on to watch it, through handoffLook.
  async handoff({ tab, thread, wait }) {
    const tabId = typeof tab === 'number' ? tab : await agentTabFor(tab);
    const p = await ownerOf(tabId);
    panel.remember(tabId, thread, p.instance);
    panel.handedOff(tabId, p.instance);
    setHanded(tabId, true);
    const t = await call(p, 'handoff', { tabId }).catch((e) => {
      if (/unknown op/.test(e.message)) throw new Error(`${describe(p)} has an older BrowserBear extension; browserbear reload, then try again`);
      // You closed the tab an agent had sent there: forget it, look again.
      if (typeof tab === 'string' && /no tab with id/i.test(e.message) && sentTo.delete(tabId)) return null;
      throw e;
    });
    if (!t) return commands.handoff({ tab, thread, wait });
    marks.handedOff(tabId, thread);
    // It's the user's now: no more pulling it forward for real clicks.
    bearTabs.delete(tabId);
    // The agents' browser has no pill with a Done button in the page, so the
    // thread's Browser panel opens (without taking the focus) to show one.
    const agents = p.instance === AGENT_INSTANCE;
    if (agents && thread && tbPath()) await showBrowserPanel(thread);
    const handed = agents
      ? `tab ${tabId} is in front of the user, in its own window in the agents' browser (${p.browser || 'Helium'}); Done is in this thread's Browser panel in Threadbear: ${t.title} <${t.url}>`
      : `tab ${tabId} is in front of the user, in their own Chrome window: ${t.title} <${t.url}>`;
    if (wait) return { tabId, message: `${handed}\nWaiting for them to finish; they don't need to reply. A link to the same page as well would open a second tab.` };
    return `${handed}\nSay so when you ask them; a link to the same page as well would open a second tab. To carry on by yourself when they've finished, without them replying: browserbear handoff ${tabId} --wait`;
  },

  // One look at a tab handed to the user, for `handoff --wait`. No debugger
  // here, only what the extension can see without one: it's their tab, and
  // they may be typing a password in it. `unknown` is "can't tell right now"
  // (a profile reconnecting), which is different from the tab having gone.
  async handoffLook({ tab, text, thread }) {
    if (!profiles.size) return { unknown: true };
    let tabs;
    try {
      tabs = await call(await ownerOf(tab), 'tabs');
    } catch (e) {
      return /^no tab /.test(e.message) ? { gone: true } : { unknown: true };
    }
    const t = tabs.find((x) => x.tabId === tab);
    if (!t) {
      marks.closed(tab);
      setHanded(tab, false);
      return { gone: true };
    }
    marks.waiting(tab, thread);
    // Moved back into BrowserBear's window: the agent's to pull forward again.
    if (t.bear) bearTabs.add(tab);
    const seen = await call(await ownerOf(tab), 'probe', { tabId: tab, text }).catch((e) => (/unknown op/.test(e.message) ? { old: true } : {}));
    if (seen.old && text) return { textUnsupported: true };
    return {
      url: t.url,
      title: t.title,
      status: t.status,
      loadError: t.loadError,
      bear: t.bear,
      signInForm: seen.signInForm,
      text: seen.text,
      doneClicked: marks.doneClicked(tab),
    };
  },

  // The Done button in Threadbear's Browser panel: the agent's Chrome has no pill.
  async markDone({ tab }) {
    marks.clickedDone(tab);
    return true;
  },

  async handoffFinished({ tab }) {
    marks.finished(tab);
    // Finished. Still in the user's window, the extension says it's theirs;
    // back in BrowserBear's (or the panel), it's the agent's again.
    setHanded(tab, false);
    return true;
  },

  // After changing the extension's files: reloads it in every connected
  // profile (unpacked installs don't notice changes by themselves).
  async reload({ profile } = {}) {
    const names = [];
    for (const p of profile ? [await findProfile(profile)] : profiles.values()) {
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
    claimed.delete(tab);
    setHanded(tab, false);
    panel.forget(tab, p.instance);
    return `closed tab ${tab}`;
  },

  // Takes BrowserBear's marks off a tab and lets go of it, as the pill's ✕
  // does: for one of the user's tabs an agent has finished with.
  async release({ tab }) {
    await ownerOf(tab);
    claimed.delete(tab);
    await marks.release(tab);
    return `let go of tab ${tab}; its marks are off`;
  },
};

function onHostMessage(profile, msg) {
  if (profiles.get(profile.instance) !== profile) return; // a replaced host's late reply/event
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
    // See send(): what an error after this can say happened.
    if (msg.event === 'detached' && msg.reason === 'canceled_by_user') state(msg.tabId).cutOffAt = Date.now();
    if (msg.event === 'detached') state(msg.tabId).dialog = null;
    // The buttons on the pill in an agent's tab.
    if (msg.event === 'mark' && msg.action === 'open') marks.open(msg.tabId);
    if (msg.event === 'mark' && msg.action === 'stop') marks.stop(msg.tabId);
    // The pill's ✕: leave this tab alone, which also takes back a claim on it.
    if (msg.event === 'mark' && msg.action === 'release') {
      claimed.delete(msg.tabId);
      marks.release(msg.tabId);
    }
    if (msg.event === 'mark' && msg.action === 'done') marks.clickedDone(msg.tabId);
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

class FillStopped extends Error {}

// Tabs fill has typed into: the page it typed on, and the fields, so the
// values can't be read straight back with eval, cdp or a snapshot.
// Kept on disk, as the service restarts by itself when its code changes, and
// forgetting would let eval or secret read a filled password straight back
// (Codex's review, 19 Nov).
// Written whole and renamed in. One that can't be read back (not just
// missing) means BrowserBear can't tell which pages fill typed on, so reading
// pages back is off everywhere until it's sorted (fillUnknown).
const FILLED = path.join(HOME, 'filled-tabs.json');
let fillUnknown = false;
const filledTabs = new Map((() => {
  try {
    return JSON.parse(fs.readFileSync(FILLED, 'utf8')).map(([tab, f]) => [tab, { loaderId: f.loaderId, nodes: new Set(f.nodes) }]);
  } catch (e) {
    if (e.code !== 'ENOENT') fillUnknown = true;
    return [];
  }
})()); // tabId -> { loaderId, nodes: Set<backendNodeId> }
const saveFilled = () => {
  const tmp = `${FILLED}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify([...filledTabs].map(([tab, f]) => [tab, { loaderId: f.loaderId, nodes: [...f.nodes] }])), { mode: 0o600 });
    fs.renameSync(tmp, FILLED);
    return true;
  } catch (e) {
    // Not saved: this service still knows, but one restarted wouldn't.
    fillUnknown = true;
    fs.rmSync(tmp, { force: true });
    log('cannot save filled tabs:', e.message);
    return false;
  }
};
// Tabs fill is typing into right now, before protectFilled knows its fields,
// and how many fills each has had, so a read that a fill ran alongside is
// withheld even if the tab has moved on since (Codex's review).
const fillingTabs = new Set();
const fillCount = new Map();
function protectFilled(tabId, loaderId, nodes) {
  const was = filledTabs.get(tabId);
  const set = was && was.loaderId === loaderId ? was.nodes : new Set();
  for (const n of nodes) set.add(n);
  filledTabs.set(tabId, { loaderId, nodes: set });
  return saveFilled();
}
// The filled fields' ids while the tab is still on the page fill typed on.
async function stillFilled(tabId) {
  const f = filledTabs.get(tabId);
  if (!f) return null;
  const now = await cdp(tabId, 'Page.getFrameTree').then((r) => r.frameTree.frame.loaderId, () => null);
  // Only the record this looked at: a fill since may have made a newer one.
  if (now && now !== f.loaderId) {
    if (filledTabs.get(tabId) !== f) return filledTabs.get(tabId)?.nodes || null;
    filledTabs.delete(tabId);
    saveFilled();
    return null;
  }
  return f.nodes;
}

// Finds the sign-in fields a page shows now, for fill: the visible username
// (or email), password and one-time code inputs. Run in an isolated world, so
// the page's own scripts can't swap the DOM functions it uses, and it hands
// back the elements themselves rather than marks the page could move.
const FIND_LOGIN_FIELDS = `function () {
  const shown = (e) => !e.disabled && !e.readOnly && e.getClientRects().length > 0 && (e.checkVisibility ? e.checkVisibility() : true);
  const inputs = [...document.querySelectorAll('input')].filter(shown);
  const words = (e) => [e.name, e.id, e.placeholder, e.getAttribute('aria-label'), e.autocomplete].join(' ');
  const textish = (e) => ['text', 'email', 'tel', ''].includes(e.type);
  const password = inputs.find((e) => e.type === 'password');
  const otps = inputs.filter((e) => (textish(e) || e.type === 'number') && (e.autocomplete === 'one-time-code' || /otp|totp|2fa|mfa|one.?time|verification.?code|security.?code|authenticat/i.test(words(e))));
  let user = inputs.find((e) => textish(e) && !otps.includes(e) && (e.type === 'email' || /username|email/i.test(e.autocomplete) || /user|email|login|account|identifier/i.test(words(e))));
  if (!user && password) user = inputs.filter((e) => textish(e) && !otps.includes(e) && e.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING).pop();
  return { user: user || null, password: password || null, otp: otps[0] || null, splitCode: otps.length > 1 || otps.some((e) => e.maxLength === 1) };
}`;

// Types one value into one field fill found, in a single step in the page, so
// nothing can run between checking where the tab is and typing: the field must
// still be there, on a page whose host is one the login is saved for
// (`allowed`: { host, sub, port }, from onepassword.mjs), over https. Goes in
// as typing would (execCommand fires beforeinput and input), else by setting
// the value and sending input and change, for pages that ignore it.
const PUT_FIELD = `function (value, allowed) {
  const host = location.hostname.replace(/^www\\./, '').toLowerCase();
  const secure = location.protocol === 'https:' || (location.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(location.hostname));
  const fits = allowed.some((a) => (host === a.host || (a.sub && host.endsWith('.' + a.host))) && location.port === a.port);
  if (!secure || !fits) return 'site';
  if (!this.isConnected || this.disabled || this.readOnly || !this.getClientRects().length) return 'gone';
  this.focus();
  if (this.select) this.select();
  if (document.activeElement !== this) return 'gone';
  const typed = document.execCommand('insertText', false, value) && this.value === value;
  if (!typed) {
    const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(this), 'value')?.set;
    if (set) set.call(this, value); else this.value = value;
    this.dispatchEvent(new Event('input', { bubbles: true }));
    this.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return 'ok';
}`;

// Agent-only trial (Mike, 6 Nov 2026). While this file exists, agents keep
// to the agents' own browser (--profile agent), and Mike's own profiles are refused with what to do instead. He's trying it
// on his Mac before it goes to anyone else, so it's off unless the file is
// there: `browserbear agent-only on|off`.

const PROFILE_CMDS = new Set(['open', 'tabs', 'claim', 'reload']);
function agentOnlyRefusal(what) {
  return new Error(
    `BrowserBear is agent-only on this Mac (Mike's trial), so ${what}. Use --profile agent, the agents' own browser. ` +
      `If a page needs a sign-in, open it there and run browserbear handoff <tab> --wait, so Mike signs in there once and it stays signed in. Don't send him to his own Chrome.`,
  );
}
async function keepToAgentChrome(cmd, args) {
  if (PROFILE_CMDS.has(cmd)) {
    if (!args.profile) args.profile = 'agent';
    else if (String(args.profile).toLowerCase() !== 'agent') throw agentOnlyRefusal(`it won't use the profile "${args.profile}"`);
  }
  // A tab given by id has to be in the agent's Chrome too. handoff also takes
  // a URL, which it only ever matches to a tab an agent opened.
  if (typeof args.tab === 'number' && (await ownerOf(args.tab)).instance !== AGENT_INSTANCE) {
    throw agentOnlyRefusal(`it won't work in tab ${args.tab}, which is in one of Mike's own profiles`);
  }
}

async function onClientMessage(conn, msg) {
  const fn = commands[msg.cmd];
  let using = null; // the tab this command works in, for its marks
  busy++;
  try {
    if (['panelStill', 'panelShow', 'panelAttach', 'panelCdp', 'panelWindow', 'panelResume', 'panelShowChrome'].includes(msg.cmd)) {
      conn.write(line({ id: msg.id, ok: true, result: await panel.dispatch(conn, msg) }));
      return;
    }
    if (!fn) throw new Error(`unknown command ${msg.cmd}`);
    if (msg.cmd !== 'status') await hostsReady();
    const args = { ...(msg.args || {}), thread: msg.thread };
    // Left as text when it isn't a number: handoff also takes a URL.
    if (/^\d+$/.test(String(args.tab))) args.tab = Number(args.tab);
    // reload with no profile only reloads the extension where it's running.
    if (agentOnlyOn() && !['status', 'profiles'].includes(msg.cmd) && !(msg.cmd === 'reload' && !args.profile)) await keepToAgentChrome(msg.cmd, args);
    let owner = null;
    if (typeof args.tab === 'number' && (USES[msg.cmd] || msg.cmd === 'close')) {
      owner = await whose(args.tab);
      // Before any refusal below: a tab that's become the user's loses the
      // emulation even when the command on it is refused (Codex's review).
      await unlessAgents(args.tab, owner);
      // Only a tab known to be an agent's closes without asking. Commands that
      // change a page still go through on an extension too old to say whose a
      // tab is (before 0.3.5), as they always have.
      if (msg.cmd === 'close' && owner.who !== 'agent' && !args.userTab) throw refuseUserTab('close', args.tab, owner);
      if (ACTS.has(msg.cmd) && owner.who === 'user') {
        if (!args.userTab) throw refuseUserTab(msg.cmd, args.tab, owner);
        claimed.add(args.tab);
        owner.who = 'claimed';
      }
      // Only looking at one of the user's tabs doesn't mark it: an eval or a
      // show left Mike's own X and LinkedIn tabs titled with a thread's name.
      // Nor does one an old extension can't place.
      if (USES[msg.cmd] && owner.who && owner.who !== 'user') {
        using = args.tab;
        panel.remember(using, msg.thread, owner.p.instance);
        marks.begin(using, msg.thread, redact(USES[msg.cmd](args)));
      }
    }
    // Raw cdp that got past the refusals talks to the page anyway, so it turns
    // it off whether or not this service remembers turning it on (one
    // restarted since, Codex's review). A refused one never touches the page.
    if (msg.cmd === 'cdp' && owner) await unlessAgents(args.tab, owner, { always: true });
    // After the ownership checks, so a tab that's become the user's loses its
    // emulation even on a page eval is off on (Codex's review).
    // Asked again once it's done, in case fill typed while it ran: what it
    // read, or its error, could hold the password (Codex's review).
    const readsBack = ['eval', 'cdp', 'secret'].includes(msg.cmd) && typeof args.tab === 'number';
    const refuseIfFilled = async () => {
      if (!readsBack) return;
      if (fillUnknown) throw new Error(`${msg.cmd} is off: BrowserBear lost track of which pages 1Password fill typed on (${FILLED} couldn't be read or saved), so nothing is read back from any tab. Once the signed-in tabs have moved on, the user can delete that file`);
      if (fillingTabs.has(args.tab) || (await stillFilled(args.tab))) throw new Error(`${msg.cmd} is off in tab ${args.tab} until it leaves the page fill signed in on, so what was filled can't be read back. snap, click and key still work`);
    };
    // Counted before the first check, so a fill during it is caught too.
    const fillsBefore = fillCount.get(args.tab);
    await refuseIfFilled();
    let note;
    if (typeof args.tab === 'number' && WAKES.has(msg.cmd)) {
      if (await wake(args.tab, { draw: LOOKS_FIRST.has(msg.cmd), owner })) note = hiddenNote(args.tab);
    } else if (typeof args.tab === 'number' && msg.cmd === 'goto' && owner && agentsNow(owner)) {
      // So the next page loads unthrottled. Straight to Chrome, with no look at
      // the page first: goto is the way out of a page that's stuck, and a look
      // would wait 20 s on it and then block the navigation (Codex's review).
      await emulateFocus(args.tab).catch(() => {});
    }
    const result = await fn(args).then((r) => ({ r }), (e) => ({ e }));
    if (readsBack && fillCount.get(args.tab) !== fillsBefore) throw new Error(`${msg.cmd} in tab ${args.tab} ran while 1Password fill was signing in there, so what it read is withheld. Run it again`);
    await refuseIfFilled();
    if (result.e) throw result.e;
    conn.write(line({ id: msg.id, ok: true, result: msg.cmd === 'secret' ? result.r : redact(result.r), note }));
  } catch (e) {
    conn.write(line({ id: msg.id, ok: false, error: redact(e.message) }));
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
        const known = chromeProfiles()?.find((p) => p.email && p.email === msg.email) || {};
        const old = profiles.get(msg.instance);
        // Same profile reconnecting: keep pending calls' bookkeeping fresh.
        if (old && old.conn !== conn) {
          panel.disconnected(old.instance);
          for (const w of old.pending.values()) { clearTimeout(w.timer); w.reject(new Error(`${describe(old)} reconnected`)); }
          old.pending.clear();
          old.conn.destroy();
        }
        profile = { instance: msg.instance, email: msg.email, name: msg.name || known.name || menuNames.get(msg.email), menuName: menuNames.get(msg.email), dir: known.dir, browser: msg.browser, conn, pending: new Map() };
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
      panel.disconnected(profile.instance);
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
  let quitting = false;
  setInterval(async () => {
    if (quitting) return;
    const now = fs.statSync(SOCKET, { throwIfNoEntry: false });
    if (now?.ino !== ino) {
      quitting = true;
      log('socket gone; exiting');
      process.exit(0);
    }
    const stamp = codeStamp();
    if (busy || !stamp || stamp === code) return;
    quitting = true;
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
