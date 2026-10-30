// BrowserBear extension: a thin pipe between the BrowserBear service on the Mac and this
// Chrome profile. All the page smarts (snapshots, refs, clicking) live in the
// service, so this file rarely has to change. It only:
//  - keeps a native-messaging port open to the host (which also keeps this
//    service worker alive: an open native port counts as activity),
//  - says hello with the profile's signed-in account, so agents can ask for
//    "Work" instead of a number that changes between connects,
//  - runs a handful of ops: list/open/close tabs, raw CDP through
//    chrome.debugger, downloads.

const HOST = 'dev.browserbear.host';
// Detach the debugger this long after a tab's last command, so Chrome's
// "started debugging this browser" bar goes away between jobs.
const IDLE_DETACH_MS = 30_000;

let port = null;
const attached = new Map(); // tabId -> idle-detach timer
// How far the chain to the Mac gets, for the setup page. An error is kept
// through the 2 s retries until the host really answers, so the page doesn't
// flicker between "checking" and "missing".
const link = { host: 'connecting', error: null, service: false, profile: null };

function connect() {
  if (port) return;
  port = chrome.runtime.connectNative(HOST);
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError?.message;
    console.warn('browserbear: host disconnected', error);
    Object.assign(link, { host: 'error', error: error || 'host disconnected', service: false, profile: null });
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
  // From the host: whether it has reached the service (it says so as soon as
  // it starts, so "up" also means Chrome could start it).
  if (msg.type === 'service') {
    Object.assign(link, { host: 'up', error: null, service: msg.up });
    if (!msg.up) link.profile = null;
    return;
  }
  // From the service, after our hello: the name agents will use for us.
  if (msg.type === 'welcome') {
    Object.assign(link, { host: 'up', error: null, service: true, profile: { name: msg.name || null, email: msg.email || null, dir: msg.dir || null } });
    return;
  }
  if (msg.type) return; // some other notice from a newer host or service
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

// Which window is yours, as opposed to BrowserBear's own: the one you last had in
// front. Kept in session storage because this worker sleeps between jobs;
// the listener below wakes it for each focus change.
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  const { bearWindow } = await chrome.storage.session.get('bearWindow');
  if (windowId === bearWindow) return;
  const win = await chrome.windows.get(windowId).catch(() => null);
  if (win?.type === 'normal') await chrome.storage.session.set({ userWindow: windowId });
});

async function userWindow() {
  const { bearWindow, userWindow: id } = await chrome.storage.session.get(['bearWindow', 'userWindow']);
  const last = id && (await chrome.windows.get(id).catch(() => null));
  if (last) return last;
  // Nothing remembered yet (Chrome just started): the last focused window,
  // unless that's BrowserBear's, then any other normal one.
  const focused = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
  if (focused && focused.id !== bearWindow) return focused;
  const all = await chrome.windows.getAll({ windowTypes: ['normal'] });
  return all.find((w) => w.id !== bearWindow) || null;
}

const ops = {
  // `agent` marks the tabs an agent opened: in BrowserBear's window, or
  // handed from there to you.
  async tabs() {
    const tabs = await chrome.tabs.query({});
    const { bearWindow, handedOff = [] } = await chrome.storage.session.get(['bearWindow', 'handedOff']);
    return tabs.map((t) => ({ ...tabInfo(t), agent: t.windowId === bearWindow || handedOff.includes(t.id) }));
  },

  // Opens the tab in a window of BrowserBear's own (one per profile, made the first
  // time and reused), so agents never take over the tab you're looking at.
  // It has to stay visible: Chrome holds back real clicks on tabs you can't
  // see (a click on a background tab took 15 s on 29 Oct), so it's a normal
  // window you can park on another screen, not a minimised one.
  // No tab groups: Chrome saves every group in a window that closes and pins
  // it to your bookmarks bar, and syncs it to your other devices. Agents'
  // groups ("poddle", "crypto", two "poddle"s...) piled up there with no
  // extension API to delete them (30 Oct). An old caller's `group` is ignored.
  async open({ url }) {
    const win = await bearWindow();
    let tab;
    if (win) {
      await ungroupAll(win.id);
      tab = await chrome.tabs.create({ url, active: true, windowId: win.id });
    } else {
      const made = await chrome.windows.create({ url, focused: false, width: 1280, height: 900 });
      await chrome.storage.session.set({ bearWindow: made.id });
      tab = made.tabs[0];
    }
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

  // For when the agent wants you to do something in a tab (sign in, pay,
  // approve): BrowserBear's own window may be on a screen you aren't looking
  // at (a Qantas sign-in sat there unseen, 30 Oct), so the tab moves into
  // your window, comes to the front and the window is focused. Your own
  // tabs stay where they are; they just come forward.
  async handoff({ tabId }) {
    let tab = await chrome.tabs.get(tabId);
    const { bearWindow, handedOff = [] } = await chrome.storage.session.get(['bearWindow', 'handedOff']);
    const agents = tab.windowId === bearWindow;
    const mine = agents && (await userWindow());
    if (mine) {
      // The agent's group label would mean nothing in your window.
      if (tab.groupId !== -1) await chrome.tabs.ungroup(tabId);
      [tab] = [].concat(await chrome.tabs.move(tabId, { windowId: mine.id, index: -1 }));
    }
    tab = await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    // Remembered so a link to the same site (Threadbear's ask buttons) can
    // find this tab again rather than open a second one.
    if (agents && !handedOff.includes(tabId)) await chrome.storage.session.set({ handedOff: [...handedOff, tabId] });
    return tabInfo(tab);
  },

  async focus({ tabId }) {
    const tab = await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return tabInfo(tab);
  },

  async cdp({ tabId, method, params }) {
    try {
      await attach(tabId);
      return await chrome.debugger.sendCommand({ tabId }, method, params || {});
    } catch (e) {
      const message = String(e?.message);
      const refused = message.includes('URL of different extension');
      if (!refused && !message.includes('Detached while handling command')) throw e;
      // Another extension's frame is in the tab, and Chrome won't let a
      // debugger near a tab that has one: it cut us off when the frame came
      // (1Password's menu on focusing an address field, passport.service.gov.uk,
      // 30 Oct), and refuses to attach again while it's there.
      const blocking = await blankExtensionFrames(tabId);
      if (!blocking.length) throw e;
      const who = `another extension's frame (${blocking.join(', ')}; a password manager's menu, usually)`;
      // A command Chrome cut off may already have run (typed text, a
      // click), so it isn't sent again; one that was refused never ran.
      if (!refused) throw new Error(`${who} appeared mid-command and Chrome detached BrowserBear. It's cleared now; snap to see whether the command ran`);
      try {
        await attach(tabId);
        return await chrome.debugger.sendCommand({ tabId }, method, params || {});
      } catch (again) {
        throw new Error(`${who} is in this tab and Chrome won't let BrowserBear in while it's there; clearing it didn't stick (${again?.message})`);
      }
    }
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

// Groups left in BrowserBear's window by older versions: ungrouping, unlike
// closing the window, doesn't leave a saved group on your bookmarks bar.
async function ungroupAll(windowId) {
  const grouped = (await chrome.tabs.query({ windowId })).filter((t) => t.groupId !== -1);
  if (grouped.length) await chrome.tabs.ungroup(grouped.map((t) => t.id));
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

// Points other extensions' frames in the tab at about:blank (and hides them),
// and says whose they were. Blanking rather than removing, so the extension
// that put one there is less likely to notice and make another. Frames inside
// closed shadow roots (1Password's) count too: chrome.dom can see into those.
async function blankExtensionFrames(tabId) {
  const results = await chrome.scripting
    .executeScript({
      target: { tabId, allFrames: true },
      args: [chrome.runtime.id],
      func: (self) => {
        const ids = [];
        const visit = (root) => {
          for (const el of root.querySelectorAll('*')) {
            const shadow = chrome.dom?.openOrClosedShadowRoot?.(el) || el.shadowRoot;
            if (shadow) visit(shadow);
            if (!['IFRAME', 'FRAME', 'EMBED', 'OBJECT'].includes(el.tagName)) continue;
            const m = /^chrome-extension:\/\/([a-p]{32})/.exec(el.src || el.data || '');
            if (!m || m[1] === self) continue;
            ids.push(m[1]);
            el.style.setProperty('display', 'none', 'important');
            if (el.tagName === 'OBJECT') el.data = 'about:blank';
            else el.src = 'about:blank';
          }
        };
        visit(document);
        return ids;
      },
    })
    .catch(() => []);
  const ids = [...new Set(results.flatMap((r) => r.result || []))];
  // Give the blanked frames a moment to actually navigate away.
  if (ids.length) await new Promise((r) => setTimeout(r, 200));
  return ids;
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

// The setup page: a checklist of what this profile still needs. It opens by
// itself on first install, and from the toolbar button (the manifest's action
// has no popup, so a click lands here).
const SETUP_URL = chrome.runtime.getURL('setup.html');

async function openSetup() {
  const [tab] = await chrome.tabs.query({ url: SETUP_URL });
  if (!tab) return chrome.tabs.create({ url: SETUP_URL });
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}

chrome.action.onClicked.addListener(() => openSetup());

// The setup page polls this every second or so.
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id || msg?.type !== 'setup-status') return;
  connect(); // in case the worker slept and lost its port
  reply({ link: { ...link } });
});

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(({ reason }) => {
  connect();
  if (reason === 'install') openSetup();
});
// Alarms wake a sleeping worker, so a lost port gets reopened within a minute
// even if the reconnect timer died with the worker.
chrome.alarms.create('browserbear-reconnect', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(connect);
connect();
