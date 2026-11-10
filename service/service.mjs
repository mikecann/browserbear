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
    for (let i = 0; i < 150 && !profiles.has('agent-chrome'); i++) await sleep(100);
    agentChrome = null;
    if (!profiles.has('agent-chrome')) throw new Error("the agent's Chrome didn't start; see agent/host.log in BrowserBear's folder");
  })();
  return agentChrome;
}

const opening = new Map(); // what was asked for -> the profile it's opening
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
const ACTS = new Set(['click', 'type', 'key', 'goto', 'upload', 'dialog', 'cdp', 'fill']);
const NOT_YOURS = "If you meant a tab you opened, use the id browserbear open printed (open --id prints only that), not a match from browserbear tabs.";

function refuseUserTab(cmd, tabId, { who, left, t }) {
  const page = `"${t.title.slice(0, 60)}" <${t.url.slice(0, 100)}>`;
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

const panel = createPanel({ home: HOME, profiles: () => [...profiles.values()], call, mark: tabId => marks.get(tabId) });

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
  // frames: the tab's cross-origin iframes by targetId, as loadFrames last saw
  // them; objects: which frame a remote object id came from (objectId -> targetId).
  if (!tabState.has(tabId)) tabState.set(tabId, { refs: new RefMap(), last: null, dialog: null, frames: new Map(), objects: new Map() });
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

// `frame` says which iframe a command without a node or object in it is for.
async function cdp(tabId, method, params, timeoutMs = CDP_WAIT_MS, frame = null) {
  const p = await ownerOf(tabId);
  const s = state(tabId);
  if (inFrame(params?.backendNodeId)) {
    const n = splitNode(params.backendNodeId);
    frame = n.frame;
    params = { ...params, backendNodeId: n.id };
  } else if (!frame && params?.objectId) {
    frame = s.objects.get(params.objectId) || null;
  }
  try {
    if (!frame) return await send(p, tabId, method, params, timeoutMs);
    const result = await sendToFrame(p, tabId, frame, method, params, timeoutMs);
    noteObjects(s, frame, result);
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
  const got = await call(await ownerOf(tabId), 'frames', { tabId }).catch(() => []);
  const list = Array.isArray(got) ? got : [];
  const bySession = new Map(list.map((f) => [f.sessionId, f.targetId]));
  const frames = new Map(list.map((f) => [f.targetId, { sessionId: f.sessionId, url: f.url, parent: (f.parent && bySession.get(f.parent)) || null }]));
  state(tabId).frames = frames;
  return frames;
}

async function sendToFrame(p, tabId, frame, method, params, timeoutMs) {
  let f = state(tabId).frames.get(frame);
  for (let tries = 0; ; tries++) {
    if (!f) f = (await loadFrames(tabId)).get(frame);
    if (!f) throw new Error(`that ref is in a frame tab ${tabId} no longer has; snap ${tabId} for fresh refs`);
    try {
      return await call(p, 'cdp', { tabId, method, params, sessionId: f.sessionId }, timeoutMs);
    } catch (e) {
      // The extension detaches after 30 s idle, which ends the frame's session
      // too; asking for frames again gives the same frame a new one.
      if (tries || !/session/i.test(e.message)) throw e;
      f = null;
    }
  }
}

// Remote objects made in a frame live there, so later commands on them
// (callFunctionOn with an objectId) have to go there too.
function noteObjects(s, frame, result, depth = 0) {
  if (!result || typeof result !== 'object' || depth > 4) return;
  if (typeof result.objectId === 'string') {
    if (s.objects.size > 5000) s.objects.clear();
    s.objects.set(result.objectId, frame);
  }
  for (const v of Array.isArray(result) ? result : Object.values(result)) noteObjects(s, frame, v, depth + 1);
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

async function send(p, tabId, method, params, timeoutMs) {
  // Input has its own short wait, where running out means "probably landed".
  if (method.startsWith('Input.')) return call(p, 'cdp', { tabId, method, params }, timeoutMs);
  // Browser-side recovery must still work when the page's JavaScript is stuck.
  const recovery = /^(Page\.(getNavigationHistory|navigate|handleJavaScriptDialog)$|Emulation\.(clearDeviceMetricsOverride|setFocusEmulationEnabled)$|Target\.getTargetInfo$)/.test(method);
  if (state(tabId).stuck && !recovery) await stillStuck(p, tabId);
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
  // In a frame, asked of the frame.
  const { frame, id } = inFrame(backendNodeId) ? splitNode(backendNodeId) : { frame: null, id: backendNodeId };
  const hit = await cdp(tabId, 'DOM.getNodeForLocation', { x: Math.round(at.x), y: Math.round(at.y), ignorePointerEventsNone: true }, undefined, frame).catch(() => null);
  if (!hit?.backendNodeId) return { ok: false, what: 'nothing' };
  if (hit.backendNodeId === id) return { ok: true };
  const [{ object: target }, { object: top }] = await Promise.all([
    cdp(tabId, 'DOM.resolveNode', { backendNodeId }),
    cdp(tabId, 'DOM.resolveNode', { backendNodeId: frameNode(frame, hit.backendNodeId) }),
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
async function wake(tabId) {
  if (state(tabId).dialog) return;
  const visibility = await evaluate(tabId, 'document.visibilityState').catch(() => null);
  if (visibility !== 'hidden') return;
  if (!bearTabs.has(tabId)) {
    const tab = (await call(await ownerOf(tabId), 'tabs')).find((t) => t.tabId === tabId);
    if (!tab?.agent) return;
  }
  await cdp(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true });
  await drawn(tabId); // what it held back
}

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
  await evaluate(tabId, DRAWN).catch(() => {});
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
      const tree = await cdp(tabId, 'Page.getFrameTree', {}, PROBE_MS, session).then((r) => r.frameTree, () => null);
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
  } catch {
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
        cdp(tabId, 'Accessibility.getFullAXTree', d.inProcess ? { frameId: id } : {}, PROBE_MS, d.session).then((r) => r.nodes, () => null),
        cdp(tabId, 'DOM.getFrameOwner', { frameId: id }, PROBE_MS, sessionOf(d.parent)).then((r) => r.backendNodeId, () => null),
        d.inProcess ? inProcessFileInputs(tabId, id, d) : fileInputs(tabId, id, PROBE_MS),
      ]);
    }),
  );
  return docs;
}

async function snapshot(tabId, { full = false } = {}) {
  const s = state(tabId);
  // A JS dialog freezes the page, so every other call would just time out.
  if (s.dialog) return `tab ${tabId}\n${dialogLine(tabId, s.dialog)}`;
  await wake(tabId);
  await cdp(tabId, 'Page.enable');
  const [{ nodes }, files, frames] = await Promise.all([cdp(tabId, 'Accessibility.getFullAXTree'), fileInputs(tabId), frameTrees(tabId)]);
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
    return compact(axNodes, refs, frame ? frames.get(frame).files : files, frame ? undefined : masked, inline);
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
    // Refused: it went to a warning page, which won't change by waiting, and
    // the snapshot after this says so.
    const look = await evaluate(tabId, `[window.__browserbear ?? null, document.readyState]`).catch((e) => (e.refused ? ['here'] : null));
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
async function clickNode(tabId, backendNodeId, { script = false, sending = () => {} } = {}) {
  const p = await ownerOf(tabId);
  let tab = (await call(p, 'tabs')).find((t) => t.tabId === tabId);
  if (!tab?.active && bearTabs.has(tabId)) tab = await call(p, 'show', { tabId });
  if (script) {
    sending();
    await scriptClick(tabId, backendNodeId);
    return '(script click, as asked)';
  }
  const at = tab?.active ? await center(tabId, backendNodeId) : null;
  if (!at) {
    sending();
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

// Punctuation's char codes are other keys' key codes: 46, a full stop, is Delete,
// which a page handling its own keydowns takes at its word.
const PUNCTUATION = { '.': ['Period', 190], ',': ['Comma', 188], '-': ['Minus', 189], '=': ['Equal', 187], '/': ['Slash', 191], ';': ['Semicolon', 186], "'": ['Quote', 222], '[': ['BracketLeft', 219], ']': ['BracketRight', 221], '\\': ['Backslash', 220], '`': ['Backquote', 192], ' ': ['Space', 32] };
function charKey(key) {
  if (PUNCTUATION[key]) return { code: PUNCTUATION[key][0], keyCode: PUNCTUATION[key][1], text: key };
  if (/^[0-9]$/.test(key)) return { code: `Digit${key}`, keyCode: key.charCodeAt(0), text: key };
  return { code: `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0), text: key };
}

// "Enter", "Meta+a", "Shift+Tab"
async function pressKey(tabId, combo) {
  await cdp(tabId, 'Page.enable');
  const parts = combo.split('+');
  const key = parts.pop();
  const modifiers = parts.reduce((m, p) => m | (MODS[p] || 0), 0);
  const k = KEYS[key] || charKey(key);
  const ev = { key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers };
  // Text only goes with an unmodified key, or Cmd+A would type an "a". Shift+Enter
  // is the exception: without its text Chrome sends the keydown alone, with no
  // keypress or beforeinput (insertLineBreak), so Slate editors like Discord's never
  // saw a line break (2 Nov).
  const text = !modifiers || combo === 'Shift+Enter' ? k.text : undefined;
  const commands = MAC_COMMANDS[combo] ? [MAC_COMMANDS[combo]] : undefined;
  // The editing command and the text only work on a full keyDown; rawKeyDown ignores them.
  const type = modifiers && !commands && !text ? 'rawKeyDown' : 'keyDown';
  await cdp(tabId, 'Input.dispatchKeyEvent', { ...ev, type, text, commands });
  await cdp(tabId, 'Input.dispatchKeyEvent', { ...ev, type: 'keyUp' });
}

// Text as real key presses, one character at a time. Not through pressKey, which
// would take a "+" for a combination. Real input is held back on a tab you can't
// see, so an agent's tab comes forward first; your own tabs aren't pulled forward.
async function typeKeys(tabId, text) {
  const p = await ownerOf(tabId);
  const tab = (await call(p, 'tabs')).find((t) => t.tabId === tabId);
  if (!tab?.active && bearTabs.has(tabId)) await call(p, 'show', { tabId });
  for (const key of text) {
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
  const field = await pinField(tabId, node).catch(() => null);
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
  const field = text && !text.includes('\n') ? await pinField(tabId, node).catch(() => null) : null;
  const before = field && (await watchField(tabId, field, text).catch(() => null));
  await cdp(tabId, 'Input.insertText', { text });
  await settle();
  if (!before) return ''; // a canvas editor, say: nothing to read back
  // Gone means the page moved on or redrew the field, which isn't a sign of trouble.
  const read = () => readPinned(tabId, field).catch(() => null);
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
  if (await unchanged()) {
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
  // One character kept out of several is what a code box does when typeSplit can't
  // see its neighbours (each in a shadow root of its own, say).
  const oneBox = [...after.value].length === 1 && bare(text).length > 1 ? ". If this is a row of one-character boxes, type each character into its own box by its ref" : '';
  if (!norm(text)(after.value).includes(norm(text)(text))) throw new Error(`type didn't work on tab ${tabId}: the field holds ${shown(after)}, which doesn't have ${JSON.stringify(text)} in it. Nothing was submitted. The page may have cut it short or changed it; snap to see${oneBox}`);
  if (doubled(before.base, after.value, text)) throw new Error(`type went wrong on tab ${tabId}: ${JSON.stringify(text)} went in more than once, and the field now holds ${shown(after)}. Nothing was submitted. If the field should hold just that text, browserbear type ${tabId} ${node ? '<ref>' : '-'} ${JSON.stringify(text)} --replace puts it in over what's there`);
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
      let noOp = false, base = field.value ?? field.innerText;
      try {
        if (field.value !== undefined && field.selectionStart !== field.selectionEnd) {
          noOp = field.value.slice(field.selectionStart, field.selectionEnd) === text;
          base = field.value.slice(0, field.selectionStart) + field.value.slice(field.selectionEnd);
        }
      } catch {}
      if (field.value === undefined) {
        const picked = field.ownerDocument.getSelection().toString();
        if (picked.trim() && picked.replace(/\\s+/g, '') === field.innerText.replace(/\\s+/g, '')) base = '';
        else if (picked.trim() && field.contains(field.ownerDocument.getSelection().anchorNode)) base = field.innerText.replace(picked, '');
      }
      ${READ_FIELD.replace('return {', 'return { noOp, base,')}
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
  if (await onField(tabId, node, SELECT_FIELD).catch(() => null)) {
    await insert();
    await settle();
    // Given a moment, as in typeChecked: an editor that shows it late would
    // otherwise get it again below, and end up with it twice.
    let read = await onField(tabId, node, READ_FIELD);
    for (let waited = 0; read && !holds(read, text) && waited < LATE_INPUT_MS; waited += 150) {
      await sleep(150);
      read = await onField(tabId, node, READ_FIELD);
    }
    if (read && holds(read, text)) return '';
  }
  if (node) await clickNode(tabId, node);
  await pressKey(tabId, 'Meta+a');
  await pressKey(tabId, 'Backspace');
  await settle();
  const cleared = await onField(tabId, node, READ_FIELD);
  if (text) await cdp(tabId, 'Input.insertText', { text });
  await settle();
  let read = await onField(tabId, node, READ_FIELD);
  // Ignored the inserted text, as a masked field does (see typeChecked).
  if (text && read && read.value === cleared?.value) {
    await typeKeys(tabId, text);
    await settle();
    read = await onField(tabId, node, READ_FIELD);
  }
  // A canvas editor (Google Docs) has no field to read back.
  if (!read) return "(this editor can't be read back, so check below that the text was replaced)";
  // Still holding it a moment later: the first attempt's text turning up late
  // would land on top of this one.
  if (holds(read, text)) {
    await sleep(LATE_INPUT_MS);
    read = (await onField(tabId, node, READ_FIELD)) || read;
  }
  if (holds(read, text)) return '';
  throw new Error(`--replace didn't work on tab ${tabId}: the field holds ${shown(read)}, not ${JSON.stringify(text)}. Nothing was submitted. The page may have changed or reformatted it; snap to see`);
}

async function evaluate(tabId, expression) {
  const r = await cdp(tabId, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

// For the waits on a page to load: a refusal or a closed tab won't get better by
// trying again.
const unlessRefused = (e) => {
  if (e.refused || e.closed) throw e;
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
        out.push(`  ${t.tabId}${t.active ? '*' : ' '} ${t.title.slice(0, 60)} <${t.url.slice(0, 100)}>${user}${marks.label(t.tabId)}`);
      }
    }
    // Handoffs of tabs that have since closed, so a later tab given the same id
    // (Chrome starts them again after a restart) isn't taken for one.
    if (!profile) for (const id of handed) if (!seen.has(id)) setHanded(id, false);
    return out.join('\n');
  },

  async open({ profile, url, thread }) {
    const p = await findProfile(profile);
    const tab = remember(p.instance, await call(p, 'open', { url, thread }, 40_000));
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
      return `several tabs match; pick one by id:\n${hits.map(({ p, t }) => `  ${t.tabId} [${describe(p)}] ${t.title.slice(0, 60)} <${t.url.slice(0, 100)}>`).join('\n')}`;
    }
    claimed.add(hits[0].t.tabId);
    marks.used(hits[0].t.tabId, thread, 'looking at the page');
    panel.remember(hits[0].t.tabId, thread, hits[0].p.instance);
    return snapshot(hits[0].t.tabId);
  },

  snap: ({ tab, full }) => snapshot(tab, { full }),

  click: ({ tab, ref, script }) =>
    orClosed(tab, async (sending) => {
      const node = await nodeFor(tab, ref);
      const before = state(tab).last;
      const startUrl = (await tabNow(tab))?.url;
      await markPage(tab);
      const note = await clickNode(tab, node, { script, sending });
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
      const boxes = chars.length ? await splitRow(tab, node).catch(() => null) : null;
      sending();
      const { note, left } = boxes ? await typeSplit(tab, boxes, chars) : { note: replace ? await replaceText(tab, node, text) : await typeChecked(tab, node, text) };
      if (submit && !left) {
        await markPage(tab);
        await pressKey(tab, 'Enter');
        await settleAfterAction(tab);
      }
      return (note ? note + '\n' : '') + (await snapshot(tab));
    }),

  // Sign in from 1Password (onepassword.mjs): whatever of username, password
  // and one-time code the page is asking for now, so a two-step sign-in
  // (Google's email page, then its password page) takes a fill on each. The
  // values go from 1Password into the page and nowhere else: what comes back
  // is which login and which fields, nothing the page wrote. Until the tab
  // loads another page, eval and cdp are refused there and snapshots hide the
  // filled fields, so the values can't be read back either.
  async fill({ tab, item, submit }) {
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
    try {
      for (const [which, value, label] of [['user', secret.username, 'username'], ['password', secret.password, 'password'], ['otp', secret.otp, 'one-time code']]) {
        if (!fields[which] || !value) continue;
        // Approving in 1Password takes a while; the tab may have gone
        // somewhere else meanwhile, and a login only goes to its own site.
        backendIds.push((await cdp(tab, 'DOM.describeNode', { objectId: fields[which] })).node.backendNodeId);
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
      }
    }
    if (!filled.length) throw new Error(`"${login.title}" in 1Password has nothing for the fields on this page`);
    if (submit) {
      await markPage(tab);
      await pressKey(tab, 'Enter').catch(() => {});
      await settleAfterAction(tab).catch(() => {});
    }
    return `filled the ${filled.join(', ')} from 1Password ("${login.title}") in tab ${tab}${submit ? ' and pressed Enter' : "; press the page's sign-in button (or run fill again with --submit)"}. Snap it to see the next step.`;
  },

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
    await waitForReady(tab).catch(() => {});
    await wake(tab);
    await drawn(tab);
    const failure = loadFailure((await call(p, 'tabs')).find((t) => t.tabId === tab));
    if (failure) throw new Error(`${failure}. ${wayOut(tab)}`);
    return (await snapshot(tab)) + (await handoffHint(tab));
  },

  // The page's text, for reading rather than acting. Long pages go to a file.
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
    const inner = await Promise.all(frames.map(([id, d]) => (shown(id) ? evalIn(tab, id, d, FRAME_TEXT).then((r) => r.result?.value, () => '') : '')));
    frames.forEach(([, f], i) => {
      if (typeof inner[i] === 'string' && inner[i].trim()) text += `\n\n[frame ${hostOf(f.url) || f.url}]\n${inner[i]}`;
    });
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
const filledTabs = new Map(); // tabId -> { loaderId, nodes: Set<backendNodeId> }
function protectFilled(tabId, loaderId, nodes) {
  const was = filledTabs.get(tabId);
  const set = was && was.loaderId === loaderId ? was.nodes : new Set();
  for (const n of nodes) set.add(n);
  filledTabs.set(tabId, { loaderId, nodes: set });
}
// The filled fields' ids while the tab is still on the page fill typed on.
async function stillFilled(tabId) {
  const f = filledTabs.get(tabId);
  if (!f) return null;
  const now = await cdp(tabId, 'Page.getFrameTree').then((r) => r.frameTree.frame.loaderId, () => null);
  if (now && now !== f.loaderId) {
    filledTabs.delete(tabId);
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
    if (['eval', 'cdp'].includes(msg.cmd) && typeof args.tab === 'number' && (await stillFilled(args.tab))) {
      throw new Error(`${msg.cmd} is off in tab ${args.tab} until it leaves the page fill signed in on, so what was filled can't be read back. snap, click and key still work`);
    }
    if (agentOnlyOn() && !['status', 'profiles'].includes(msg.cmd) && !(msg.cmd === 'reload' && !args.profile)) await keepToAgentChrome(msg.cmd, args);
    if (typeof args.tab === 'number' && (USES[msg.cmd] || msg.cmd === 'close')) {
      const owner = await whose(args.tab);
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
        marks.begin(using, msg.thread, USES[msg.cmd](args));
      }
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
