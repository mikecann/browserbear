#!/usr/bin/env node
// The agents' own browser, in place of the extension in Mike's profiles.
//
// It's Helium (or Google Chrome where Helium isn't installed) with a profile
// folder of its own, so it never touches the Chrome he's using, and it speaks
// the extension's side of the service's protocol (tabs, open, navigate, cdp and
// so on), so every page smart in service.mjs still works. Found by trying them
// (5 and 8 Nov 2026):
//  - Headless Chrome and CEF are rejected by Google's sign-in ("This browser or
//    app may not be secure"). Real windowed Chrome and stock Helium aren't,
//    even with the debugging port open and scripted input.
//  - A fixed debugging port doesn't set navigator.webdriver; a pipe would.
//  - Each page gets a real window of its own, opened behind Mike's windows: a
//    tab behind another in its window stops drawing, and so does a minimised
//    window. Covered windows keep drawing and taking input with the flags below.
//
// Threadbear's Browser panel reads tabs.json to learn which tabs a thread has,
// and asks the service for a still of each page and to bring its window forward.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { HOME, SOCKET, line, lineReader } from '../service/wire.mjs';

export const DIR = path.join(HOME, 'agent');
const STATE = path.join(DIR, 'tabs.json');
const IDS = path.join(DIR, 'tab-ids.json');
const PORT = Number(process.env.BROWSERBEAR_AGENT_PORT) || 9339;
const WIDTH = 1280;
const HEIGHT = 900;

// The agents' browser is Helium (helium.computer) where it's installed: a
// Chromium that Google's sign-in accepts, and that's signed with Apple's
// passkey entitlement for browsers, so Touch ID passkeys work. That entitlement
// belongs to Helium's own signature, so it's always launched as shipped, never
// re-signed or bundled. It updates itself. Without it, Google Chrome.
// BROWSERBEAR_AGENT_APP picks another (a path to an .app).
function agentApp() {
  const want = process.env.BROWSERBEAR_AGENT_APP;
  if (want) return want;
  for (const dir of ['/Applications', path.join(os.homedir(), 'Applications')]) {
    const helium = path.join(dir, 'Helium.app');
    if (fs.existsSync(helium)) return helium;
  }
  return 'Google Chrome';
}
export const APP = agentApp();
export const BROWSER_NAME = path.basename(APP).replace(/\.app$/, '');
// A folder per browser: Helium can't read Chrome's saved sign-ins (each keeps
// its cookie key in its own Keychain item), and a profile shouldn't be passed
// between two browsers. Google Chrome keeps the folder it always had.
const PROFILE = path.join(DIR, BROWSER_NAME === 'Google Chrome' ? 'chrome-profile' : `${BROWSER_NAME.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-profile`);

// Its windows are real windows on Mike's screens, opened behind whatever he's
// using (8 Nov: the parked windows streamed into Threadbear's panel are gone).
// --no-startup-window: otherwise the first window comes up in front of him.
// The backgrounding switches keep a covered window drawing and taking input,
// which agents need when their window is behind his (checked on Tinker Desk).
const CHROME_FLAGS = [
  `--user-data-dir=${PROFILE}`,
  `--remote-debugging-port=${PORT}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--no-startup-window',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
];

fs.mkdirSync(PROFILE, { recursive: true, mode: 0o700 });
const logFile = fs.createWriteStream(path.join(DIR, 'host.log'), { flags: 'a' });
const log = (...a) => logFile.write(`${new Date().toISOString()} ${a.join(' ')}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Chrome ----

async function browserWsUrl() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/version`).catch(() => null);
  return r?.ok ? (await r.json()).webSocketDebuggerUrl : null;
}

// The program on the debugging port, from its process list: /json/version says
// "Chrome/..." for Helium too.
async function runningApp(url) {
  const sock = new WebSocket(url);
  try {
    await new Promise((resolve, reject) => { sock.onopen = resolve; sock.onerror = reject; });
    const info = await new Promise((resolve) => {
      sock.onmessage = (e) => resolve(JSON.parse(e.data));
      sock.send(JSON.stringify({ id: 1, method: 'SystemInfo.getProcessInfo' }));
      setTimeout(() => resolve(null), 3000);
    });
    const pid = info?.result?.processInfo?.find((p) => p.type === 'browser')?.id;
    if (!pid) return { sock, path: null };
    const { execFileSync } = await import('node:child_process');
    return { sock, pid, path: execFileSync('/bin/ps', ['-o', 'comm=', '-p', String(pid)]).toString().trim() };
  } catch {
    sock.close();
    return { sock: null, path: null };
  }
}

// The browser updates itself on disk while it runs, and the running copy then
// can't start any new page: its helper app went with the old version's folder.
// Every new tab stays an empty shell with no URL, and every command to it times
// out (Helium 156 to 157 on 11 Nov 2026, with Page.enable timing out on each
// open). Chrome would say "relaunch to update"; nobody sees that here, so this
// compares the version running with the one now on disk.
function versionOnDisk(exe) {
  const app = exe?.match(/^(.*?\.app)\//)?.[1] || (APP.includes('/') ? APP : `/Applications/${APP}.app`);
  try {
    const frameworks = path.join(app, 'Contents', 'Frameworks');
    const fw = fs.readdirSync(frameworks).find((f) => f.endsWith('.framework') && fs.existsSync(path.join(frameworks, f, 'Versions', 'Current')));
    return fw ? fs.readlinkSync(path.join(frameworks, fw, 'Versions', 'Current')) : null;
  } catch {
    return null;
  }
}
async function runningVersion() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/version`).catch(() => null);
  return r?.ok ? (await r.json()).Browser?.split('/')[1] ?? null : null;
}
let browserExe = null;
async function updatedUnderneath() {
  const [running, disk] = [await runningVersion(), versionOnDisk(browserExe)];
  return running && disk && running !== disk ? { running, disk } : null;
}

// Asks the browser to quit, and if it won't, ends it: a copy that updated
// itself underneath ignored Browser.close (Helium, 12 Nov 2026). Only ever a
// process running our own profile folder, never one of Mike's browsers.
async function closeBrowser(askToClose, pid) {
  askToClose();
  for (let i = 0; i < 25 && (await browserWsUrl()); i++) await sleep(200);
  if (!(await browserWsUrl()) || !pid) return;
  const { execFileSync } = await import('node:child_process');
  let args = '';
  try {
    args = execFileSync('/bin/ps', ['-o', 'args=', '-p', String(pid)]).toString();
  } catch {}
  // The whole value, up to the next switch: not ${PROFILE}-something else.
  if (!` ${args.trim()} `.includes(` --user-data-dir=${PROFILE} `)) return;
  log("it didn't quit; ending it, pid", pid);
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    try {
      process.kill(pid, signal);
    } catch {}
    for (let i = 0; i < 25 && (await browserWsUrl()); i++) await sleep(200);
    if (!(await browserWsUrl())) return;
  }
}

const isOurApp = (exe) => !exe || (APP.includes('/') ? exe.startsWith(`${APP}/`) : exe.includes(`/${APP}.app/`));

async function ensureChrome() {
  let url = await browserWsUrl();
  if (url) {
    // Another browser on our port: the agents' old Google Chrome from before
    // Helium (8 Nov 2026), say. Close it and start the right one, or agents
    // would carry on in it under Helium's name.
    const { sock, pid, path: exe } = await runningApp(url);
    browserExe = exe;
    const stale = isOurApp(exe) && (await updatedUnderneath());
    if (isOurApp(exe) && !stale) { sock?.close(); return url; }
    if (stale) log(`${BROWSER_NAME} ${stale.running} is running but ${stale.disk} is on disk, so it can't start new pages; restarting it`);
    log('closing', exe, 'on our port, to start', APP);
    await closeBrowser(() => sock.send(JSON.stringify({ id: 2, method: 'Browser.close' })), stale ? pid : null);
    sock.close();
    if (await browserWsUrl()) throw new Error(stale ? `the agents' browser (${BROWSER_NAME}) updated itself and wouldn't quit to restart; quit it and try again` : `another browser (${exe}) is on the agents' port ${PORT} and didn't close`);
    url = null;
  }
  log('starting', APP);
  // -g: don't bring it to the front. -n: a copy of its own, beside any Mike runs.
  spawn('open', ['-g', '-n', '-a', APP, '--args', ...CHROME_FLAGS], { stdio: 'ignore' });
  for (let i = 0; i < 100 && !url; i++) {
    await sleep(200);
    url = await browserWsUrl();
  }
  if (!url) throw new Error(`the agents' browser (${BROWSER_NAME}) didn't start`);
  return url;
}

let ws;
let restarting = false;
let nextCdp = 1;
const cdpWaiting = new Map();
const sessions = new Map(); // targetId -> sessionId
const sessionTarget = new Map(); // sessionId -> targetId
// Cross-origin iframes, attached as child sessions of their tab's (see the
// extension's frameSessions). sessionId -> { tabTarget, targetId, url, parent }
const frameSessions = new Map();
const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: 'iframe' }] };

function browserCall(method, params = {}, sessionId, timeoutMs = 30_000) {
  const id = nextCdp++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cdpWaiting.delete(id);
      reject(new Error(`cdp timed out after ${timeoutMs / 1000}s: ${method}`));
    }, timeoutMs);
    cdpWaiting.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
}

async function connectChrome() {
  const url = await ensureChrome();
  const mine = (ws = new WebSocket(url));
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("couldn't connect to the agent's Chrome"));
  });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && cdpWaiting.has(m.id)) {
      const w = cdpWaiting.get(m.id);
      cdpWaiting.delete(m.id);
      clearTimeout(w.timer);
      if (m.error) w.reject(new Error(m.error.message));
      else w.resolve(m.result);
      return;
    }
    if (m.method) onEvent(m);
  };
  // Chrome was quit (by Mike, or crashed): the service sees us go, and the
  // next `--profile agent` starts us again. Unless we closed it to restart it.
  ws.onclose = () => {
    if (restarting || ws !== mine) return;
    log('Chrome went away');
    process.exit(0);
  };
  await browserCall('Target.setDiscoverTargets', { discover: true });
}

// ---- Tabs ----

const known = new Map(); // tabId -> { targetId, url, title, thread, mark, status, loadError, handoffs, openedAt }
const byTarget = new Map(); // targetId -> tabId
let ids = {};
try {
  ids = JSON.parse(fs.readFileSync(IDS, 'utf8'));
} catch {}
let nextTab = Math.max(1000, ...Object.values(ids)) + 1;
// Which thread has which page, kept so a restart of this host doesn't orphan them.
const OWNERS = path.join(DIR, 'tab-threads.json');
let owners = {};
try {
  owners = JSON.parse(fs.readFileSync(OWNERS, 'utf8'));
} catch {}
function own(tab, thread) {
  tab.thread = thread;
  if (thread) owners[tab.targetId] = thread;
  else delete owners[tab.targetId];
  fs.writeFileSync(OWNERS, JSON.stringify(owners));
}

function tabIdFor(targetId) {
  if (!ids[targetId]) {
    ids[targetId] = nextTab++;
    fs.writeFileSync(IDS, JSON.stringify(ids));
  }
  return ids[targetId];
}

const isTab = (t) => t.type === 'page' && !t.url.startsWith('devtools://');

function track(info) {
  if (!isTab(info)) return null;
  const tabId = tabIdFor(info.targetId);
  let tab = known.get(tabId);
  if (!tab) {
    tab = { tabId, targetId: info.targetId, status: 'complete', handoffs: 0, openedAt: Date.now(), thread: owners[info.targetId] };
    known.set(tabId, tab);
    byTarget.set(info.targetId, tabId);
    // A popup (a Google sign-in, say) belongs to the thread that opened it.
    if (info.openerId) {
      own(tab, known.get(byTarget.get(info.openerId))?.thread);
      tab.popup = true;
    }
  }
  if (tab.url !== info.url) tab.activeAt = Date.now();
  tab.url = info.url;
  tab.title = info.title;
  return tab;
}

const tabInfo = (t) => ({
  tabId: t.tabId,
  windowId: t.tabId,
  url: t.url || '',
  title: t.title || '',
  active: true,
  groupId: -1,
  status: t.status,
  loadError: t.loadError,
  agent: true,
  bear: true,
});

let chromePid = null;
let writing = null;
function writeState() {
  writing ||= setTimeout(() => {
    writing = null;
    const tabs = [...known.values()].map(({ tabId, targetId, url, title, thread, mark, status, handoffs, openedAt, popup }) => ({
      tabId,
      targetId,
      url,
      title,
      thread: thread ?? null,
      state: mark?.state ?? null,
      action: mark?.action ?? null,
      finish: mark?.finish ?? false,
      status,
      handoffs,
      openedAt,
      popup: !!popup,
    }));
    const tmp = `${STATE}.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ port: PORT, socket: SOCKET, pid: process.pid, chromePid, browser: BROWSER_NAME, tabs }));
    fs.renameSync(tmp, STATE);
  }, 50);
}

async function sessionFor(tab, enableTimeoutMs = 30_000) {
  const have = sessions.get(tab.targetId);
  if (have) return have;
  const { sessionId } = await browserCall('Target.attachToTarget', { targetId: tab.targetId, flatten: true });
  sessions.set(tab.targetId, sessionId);
  sessionTarget.set(sessionId, tab.targetId);
  tab.autoAttached = false;
  try {
    await browserCall('Page.enable', {}, sessionId, enableTimeoutMs);
  } catch (e) {
    // Not kept, so the next command attaches afresh rather than reuse a
    // session that never got going.
    sessions.delete(tab.targetId);
    sessionTarget.delete(sessionId);
    browserCall('Target.detachFromTarget', { sessionId }, undefined, 5_000).catch(() => {});
    throw e;
  }
  // So the page behaves as if it's in front when its window is behind others.
  await browserCall('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId).catch(() => {});
  const tree = await browserCall('Page.getFrameTree', {}, sessionId).catch(() => null);
  tab.mainFrame = tree?.frameTree?.frame?.id;
  return sessionId;
}

const tabOf = (tabId) => {
  const tab = known.get(tabId);
  if (!tab) throw new Error(`No tab with id: ${tabId}`);
  return tab;
};

// The page's window to the front, and the browser with it. Page.bringToFront
// activates the app, except the first time after it started in the background
// (open -g): then it takes a second ask (checked on Tinker Desk, 8 Nov 2026).
async function bringForward(tab) {
  const session = await sessionFor(tab);
  await browserCall('Page.bringToFront', {}, session);
  await sleep(300);
  await browserCall('Page.bringToFront', {}, session);
}

function loaded(tab, timeoutMs = 25_000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const look = () => {
      if (tab.status === 'complete' || Date.now() - start > timeoutMs) return resolve(tab);
      setTimeout(look, 50);
    };
    look();
  });
}

async function goTo(tab, url, enableTimeoutMs) {
  const session = await sessionFor(tab, enableTimeoutMs);
  tab.status = 'loading';
  tab.loadError = undefined;
  const r = await browserCall('Page.navigate', { url }, session, 40_000);
  if (r.errorText) {
    tab.status = 'complete';
    if (r.errorText !== 'net::ERR_ABORTED') tab.loadError = r.errorText;
    return tab;
  }
  // A URL that only downloads never finishes loading a page.
  if (!r.loaderId) tab.status = 'complete';
  return loaded(tab);
}

function onEvent(m) {
  const { method, params, sessionId } = m;
  if (method === 'Target.targetCreated' || method === 'Target.targetInfoChanged') {
    track(params.targetInfo);
    writeState();
    return;
  }
  if (method === 'Target.targetDestroyed') {
    const tabId = byTarget.get(params.targetId);
    if (tabId) {
      known.delete(tabId);
      byTarget.delete(params.targetId);
      sessions.delete(params.targetId);
      if (owners[params.targetId]) {
        delete owners[params.targetId];
        fs.writeFileSync(OWNERS, JSON.stringify(owners));
      }
      writeState();
    }
    return;
  }
  if (method === 'Target.attachedToTarget' && params.targetInfo?.type === 'iframe') {
    const tabTarget = sessionTarget.get(sessionId) || frameSessions.get(sessionId)?.tabTarget;
    if (!tabTarget) return;
    const { targetId, url } = params.targetInfo;
    frameSessions.set(params.sessionId, { tabTarget, targetId, url, parent: frameSessions.has(sessionId) ? sessionId : null });
    // A cross-origin frame inside that one.
    browserCall('Target.setAutoAttach', AUTO_ATTACH, params.sessionId).catch(() => {});
    return;
  }
  if (method === 'Target.detachedFromTarget') {
    frameSessions.delete(params.sessionId);
    const targetId = sessionTarget.get(params.sessionId);
    sessionTarget.delete(params.sessionId);
    if (targetId) sessions.delete(targetId);
    return;
  }
  const targetId = sessionId && sessionTarget.get(sessionId);
  const tab = targetId && known.get(byTarget.get(targetId));
  if (!tab) return;
  if (method === 'Page.frameStartedLoading' && params.frameId === tab.mainFrame) {
    tab.activeAt = Date.now();
    tab.status = 'loading';
    writeState();
  }
  if (method === 'Page.frameStoppedLoading' && params.frameId === tab.mainFrame) {
    tab.status = 'complete';
    writeState();
  }
  if (method === 'Page.javascriptDialogOpening') post({ type: 'event', event: 'dialog', tabId: tab.tabId, params });
  if (method === 'Page.javascriptDialogClosed') post({ type: 'event', event: 'dialogClosed', tabId: tab.tabId });
}

// What `handoff --wait` asks: is there still a sign-in form, and is this text
// here? Yes or no only, as with the extension. Main frame only, for now.
const PROBE = (text) => `(() => {
  const seen = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const signInForm = [...document.querySelectorAll('input[type=password]')].some(seen);
  const want = ${JSON.stringify(text ?? null)};
  return { signInForm, text: want ? (document.body?.innerText || '').includes(want) : false };
})()`;

const ops = {
  async tabs() {
    const { targetInfos } = await browserCall('Target.getTargets');
    targetInfos.forEach(track);
    writeState();
    return [...known.values()].map(tabInfo);
  },

  // One window per tab: a tab behind another in the same window stops drawing.
  // background: behind Mike's windows, without taking his focus.
  // A blank tab that doesn't answer in a few seconds never will: it's closed,
  // not left behind as an empty tab with no id given back, and a fresh one is
  // tried, after restarting the browser if it updated itself underneath us.
  async open({ url, thread }) {
    if (await updatedUnderneath()) await restartBrowser();
    let tab;
    for (let attempt = 0; ; attempt++) {
      const { targetId } = await browserCall('Target.createTarget', { url: 'about:blank', newWindow: true, background: true, width: WIDTH, height: HEIGHT });
      const { targetInfos } = await browserCall('Target.getTargets');
      tab = track(targetInfos.find((t) => t.targetId === targetId));
      own(tab, thread);
      writeState();
      try {
        await sessionFor(tab, BLANK_ANSWERS_MS);
        break;
      } catch (e) {
        log('new tab', tab.tabId, "didn't answer:", e.message);
        await browserCall('Target.closeTarget', { targetId }, undefined, 5_000).catch(() => {});
        if (attempt === 1) throw new Error(`the agents' browser (${BROWSER_NAME}) opens tabs but can't load a page in them (${e.message}). Quit ${BROWSER_NAME} (the agents' copy) and try again; it starts by itself`);
        if (attempt === 0 && (await updatedUnderneath())) await restartBrowser();
      }
    }
    await goTo(tab, url);
    writeState();
    return tabInfo(tab);
  },

  async navigate({ tabId, url }) {
    return tabInfo(await goTo(tabOf(tabId), url));
  },

  async show({ tabId }) {
    return tabInfo(tabOf(tabId));
  },

  // Brings the page's real window to the front, for "Show window" in
  // Threadbear's Browser panel.
  async focus({ tabId }) {
    const tab = tabOf(tabId);
    await bringForward(tab);
    return tabInfo(tab);
  },

  // A small picture of the page for the Browser panel's list: a JPEG about
  // `width` points wide. Works with the window covered.
  async still({ tabId, width = 480 }) {
    const session = await sessionFor(tabOf(tabId));
    const metrics = await browserCall('Page.getLayoutMetrics', {}, session, 5_000);
    const view = metrics.cssVisualViewport || metrics.visualViewport;
    const scale = Math.min(1, Math.max(120, Number(width) || 480) / view.clientWidth);
    const { data } = await browserCall('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 60,
      clip: { x: view.pageX, y: view.pageY, width: view.clientWidth, height: view.clientHeight, scale },
    }, session, 8_000);
    return { data, at: Date.now() };
  },

  async reload() {
    setTimeout(() => process.exit(0), 100);
    return true;
  },

  async close({ tabId }) {
    await browserCall('Target.closeTarget', { targetId: tabOf(tabId).targetId });
    return true;
  },

  // The page's own window comes to the front for Mike (a sign-in, a passkey,
  // a payment), with any of the browser's own sheets on it.
  async handoff({ tabId }) {
    const tab = tabOf(tabId);
    tab.handoffs += 1;
    writeState();
    await bringForward(tab).catch((e) => log('bringToFront failed', e.message));
    return tabInfo(tab);
  },

  async probe({ tabId, text }) {
    const r = await browserCall('Runtime.evaluate', { expression: PROBE(text), returnByValue: true }, await sessionFor(tabOf(tabId)), 5_000).catch(() => null);
    return r?.result?.value ?? { signInForm: null, text: false };
  },

  async cdp({ tabId, method, params, sessionId }) {
    const tab = tabOf(tabId);
    tab.activeAt = Date.now();
    if (sessionId && frameSessions.get(sessionId)?.tabTarget !== tab.targetId) throw new Error(`No session with given id: ${sessionId}`);
    return browserCall(method, params || {}, sessionId || (await sessionFor(tab)));
  },

  // The tab's cross-origin iframes, each with the sessionId cdp takes for it.
  async frames({ tabId }) {
    const tab = tabOf(tabId);
    const session = await sessionFor(tab);
    if (!tab.autoAttached) {
      await browserCall('Target.setAutoAttach', AUTO_ATTACH, session);
      tab.autoAttached = true;
      await sleep(150); // the frames already there arrive as events just after
    }
    return [...frameSessions].filter(([, f]) => f.tabTarget === tab.targetId).map(([sessionId, { targetId, url, parent }]) => ({ sessionId, targetId, url, parent }));
  },

  // The panel draws these. Nothing goes in the page, so a site can't see it.
  async mark({ tabId, mark }) {
    tabOf(tabId).mark = mark || null;
    writeState();
    return true;
  },

  async detach({ tabId }) {
    const tab = tabOf(tabId);
    const session = sessions.get(tab.targetId);
    if (session) await browserCall('Target.detachFromTarget', { sessionId: session }).catch(() => {});
    sessions.delete(tab.targetId);
    return true;
  },

  async download() {
    throw new Error(`download isn't in the agents' browser (${BROWSER_NAME}) yet: use a link click, which lands in its Downloads folder`);
  },
};

const BLANK_ANSWERS_MS = 8_000;

// Closes the browser and starts it again, for one that updated itself on disk.
// Its tabs go with it: none of them could load a new page anyway. One restart
// at a time: two opens that both see the update share it. If it fails, the
// host goes, so the service sees it gone and the next command starts it afresh
// rather than talk to a browser that isn't there.
let restartingNow = null;
function restartBrowser() {
  restartingNow ||= doRestart()
    .catch((e) => {
      log('restart failed:', e.message);
      process.exit(1);
    })
    .finally(() => { restartingNow = null; });
  return restartingNow;
}
async function doRestart() {
  restarting = true;
  try {
    log('restarting', BROWSER_NAME);
    // Not waited on: it may never answer before the connection goes.
    await closeBrowser(() => ws.send(JSON.stringify({ id: nextCdp++, method: 'Browser.close' })), chromePid);
    for (const w of cdpWaiting.values()) { clearTimeout(w.timer); w.reject(new Error(`${BROWSER_NAME} restarted`)); }
    cdpWaiting.clear();
    for (const m of [known, byTarget, sessions, sessionTarget, frameSessions]) m.clear();
    await connectChrome();
    chromePid = await browserPid();
    (await browserCall('Target.getTargets')).targetInfos.forEach(track);
    writeState();
  } finally {
    restarting = false;
  }
}

const browserPid = async () => (await browserCall('SystemInfo.getProcessInfo').catch(() => null))?.processInfo?.find((p) => p.type === 'browser')?.id ?? null;

// ---- The service ----

let sock = null;
const post = (msg) => sock?.write(line(msg));

async function onService(msg) {
  if (msg.type) return;
  const handler = ops[msg.op];
  try {
    if (!handler) throw new Error(`unknown op ${msg.op}`);
    post({ id: msg.id, ok: true, result: await handler(msg.args || {}) });
  } catch (e) {
    post({ id: msg.id, ok: false, error: String(e?.message || e) });
  }
}

function connectService(delay = 0) {
  setTimeout(() => {
    const s = net.createConnection(SOCKET);
    s.on('connect', () => {
      sock = s;
      s.write(line({ type: 'hello', instance: 'agent-chrome', email: null, name: 'agent', browser: BROWSER_NAME, version: 'agent' }));
      log('connected to service');
    });
    s.on('data', lineReader(onService));
    s.on('error', (e) => log('service socket', e.code || e.message));
    s.on('close', () => {
      sock = null;
      connectService(Math.min(5000, delay * 2 || 250));
    });
  }, delay);
}

log('host up', os.hostname());
// Said in the log, which is where the service's error points.
process.on('uncaughtException', (e) => {
  log('failed:', e?.stack || e);
  process.exit(1);
});
await connectChrome().catch((e) => {
  log('failed to start:', e.message);
  process.exit(1);
});
// For Threadbear, to hand the focus back when a page's popup takes it.
chromePid = await browserPid();
const { targetInfos } = await browserCall('Target.getTargets');
targetInfos.forEach(track);
writeState();
connectService();
