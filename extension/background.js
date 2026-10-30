// BrowserBear extension: a thin pipe between the BrowserBear service on the Mac and this
// Chrome profile. All the page smarts (snapshots, refs, clicking) live in the
// service, so this file rarely has to change. It only:
//  - keeps a native-messaging port open to the host (which also keeps this
//    service worker alive: an open native port counts as activity),
//  - says hello with the profile's signed-in account, so agents can ask for
//    "Work" instead of a number that changes between connects,
//  - runs a handful of ops: list/open/close tabs, tab groups, raw CDP through
//    chrome.debugger, downloads.

const HOST = 'dev.browserbear.host';
// Detach the debugger this long after a tab's last command, so Chrome's
// "started debugging this browser" bar goes away between jobs.
const IDLE_DETACH_MS = 30_000;

let port = null;
const attached = new Map(); // tabId -> idle-detach timer

function connect() {
  if (port) return;
  port = chrome.runtime.connectNative(HOST);
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => {
    console.warn('browserbear: host disconnected', chrome.runtime.lastError?.message);
    port = null;
    setTimeout(connect, 2000);
  });
  hello();
}

async function hello() {
  const { instance } = await chrome.storage.local.get('instance').then(async (s) => {
    if (s.instance) return s;
    const fresh = { instance: crypto.randomUUID() };
    await chrome.storage.local.set(fresh);
    return fresh;
  });
  const user = await chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' });
  post({ type: 'hello', instance, email: user.email || null, version: chrome.runtime.getManifest().version });
}

function post(msg) {
  try {
    port?.postMessage(msg);
  } catch (e) {
    console.warn('browserbear: post failed', e);
  }
}

async function onMessage(msg) {
  if (msg.type === 'ping') return post({ type: 'pong' });
  const handler = ops[msg.op];
  try {
    if (!handler) throw new Error(`unknown op ${msg.op}`);
    post({ id: msg.id, ok: true, result: await handler(msg.args || {}) });
  } catch (e) {
    post({ id: msg.id, ok: false, error: String(e?.message || e) });
  }
}

const tabInfo = (t) => ({
  tabId: t.id,
  windowId: t.windowId,
  url: t.url || t.pendingUrl || '',
  title: t.title || '',
  active: t.active,
  groupId: t.groupId,
  status: t.status,
});

const ops = {
  async tabs() {
    const tabs = await chrome.tabs.query({});
    return tabs.map(tabInfo);
  },

  // Opens the tab in a window of BrowserBear's own (one per profile, made the first
  // time and reused), so agents never take over the tab you're looking at.
  // It has to stay visible: Chrome holds back real clicks on tabs you can't
  // see (a click on a background tab took 15 s on 29 Oct), so it's a normal
  // window you can park on another screen, not a minimised one.
  // `group` puts it in a tab group (Threadbear passes the thread's title).
  async open({ url, group }) {
    const win = await bearWindow();
    let tab;
    if (win) tab = await chrome.tabs.create({ url, active: true, windowId: win.id });
    else {
      const made = await chrome.windows.create({ url, focused: false, width: 1280, height: 900 });
      await chrome.storage.session.set({ bearWindow: made.id });
      tab = made.tabs[0];
    }
    if (group) await addToGroup(tab, group);
    return tabInfo(await waitForLoad(tab.id));
  },

  // Brings a tab to the front of its window without focusing the window, so
  // it renders (and takes real input) without stealing your keyboard.
  async show({ tabId }) {
    return tabInfo(await chrome.tabs.update(tabId, { active: true }));
  },

  // Lets the service pick up a new version of these files (unpacked installs).
  async reload() {
    setTimeout(() => chrome.runtime.reload(), 100);
    return true;
  },

  async close({ tabId }) {
    await detach(tabId);
    await chrome.tabs.remove(tabId);
    return true;
  },

  async focus({ tabId }) {
    const tab = await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return tabInfo(tab);
  },

  async cdp({ tabId, method, params }) {
    await attach(tabId);
    return chrome.debugger.sendCommand({ tabId }, method, params || {});
  },

  async detach({ tabId }) {
    await detach(tabId);
    return true;
  },

  // Saves into Chrome's download folder (optionally a subfolder of it) and
  // waits for the file, so the agent gets a real path back.
  async download({ url, filename }) {
    const id = await chrome.downloads.download({ url, filename, conflictAction: 'uniquify' });
    return waitForDownload(id);
  },
};

async function bearWindow() {
  const { bearWindow: id } = await chrome.storage.session.get('bearWindow');
  if (!id) return null;
  return chrome.windows.get(id).catch(() => null);
}

async function addToGroup(tab, title) {
  const [existing] = await chrome.tabGroups.query({ title, windowId: tab.windowId });
  if (existing) return chrome.tabs.group({ tabIds: [tab.id], groupId: existing.id });
  const groupId = await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId: tab.windowId } });
  await chrome.tabGroups.update(groupId, { title, color: 'blue' });
}

function waitForLoad(tabId, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    const done = async () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(await chrome.tabs.get(tabId));
    };
    const listener = (id, change) => {
      if (id === tabId && change.status === 'complete') done();
    };
    // A slow page still comes back after the timeout; the agent can look at
    // it and decide, rather than getting an error.
    const timer = setTimeout(done, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((t) => t.status === 'complete' && done());
  });
}

function waitForDownload(id, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const check = async () => {
      const [item] = await chrome.downloads.search({ id });
      if (item?.state === 'complete') finish(() => resolve({ path: item.filename, bytes: item.fileSize }));
      else if (item?.state === 'interrupted') finish(() => reject(new Error(`download interrupted: ${item.error}`)));
    };
    const finish = (fn) => {
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(listener);
      fn();
    };
    const listener = (delta) => delta.id === id && check();
    const timer = setTimeout(() => finish(() => reject(new Error('download timed out'))), timeoutMs);
    chrome.downloads.onChanged.addListener(listener);
    check();
  });
}

async function attach(tabId) {
  if (!attached.has(tabId)) {
    try {
      await chrome.debugger.attach({ tabId }, '1.3');
      // So dialogs (like "Leave site?") are reported from the first command.
      await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
    } catch (e) {
      // Already attached by us from before a worker restart is fine.
      if (!String(e?.message).includes('Another debugger is already attached')) throw e;
    }
  }
  clearTimeout(attached.get(tabId));
  attached.set(tabId, setTimeout(() => detach(tabId), IDLE_DETACH_MS));
}

async function detach(tabId) {
  clearTimeout(attached.get(tabId));
  if (!attached.delete(tabId)) return;
  await chrome.debugger.detach({ tabId }).catch(() => {});
}

chrome.debugger.onDetach.addListener(({ tabId }, reason) => {
  clearTimeout(attached.get(tabId));
  attached.delete(tabId);
  post({ type: 'event', event: 'detached', tabId, reason });
});

chrome.debugger.onEvent.addListener(({ tabId }, method, params) => {
  // Only what the service needs to know about; everything else stays here.
  if (method === 'Page.javascriptDialogOpening') post({ type: 'event', event: 'dialog', tabId, params });
  if (method === 'Page.javascriptDialogClosed') post({ type: 'event', event: 'dialogClosed', tabId });
});

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
// Alarms wake a sleeping worker, so a lost port gets reopened within a minute
// even if the reconnect timer died with the worker.
chrome.alarms.create('browserbear-reconnect', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(connect);
connect();
