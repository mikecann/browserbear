// BrowserBear extension: a thin pipe between the BrowserBear service on the Mac and this
// Chrome profile. All the page smarts (snapshots, refs, clicking) live in the
// service, so this file rarely has to change. It only:
//  - keeps a native-messaging port open to the host (which also keeps this
//    service worker alive: an open native port counts as activity),
//  - says hello with the profile's signed-in account, so agents can ask for
//    "Work" instead of a number that changes between connects,
//  - runs a handful of ops: list/open/close tabs, raw CDP through
//    chrome.debugger, downloads,
//  - draws the marks on agents' tabs (the thread's name and a pill).

const HOST = 'dev.browserbear.host';
// Detach the debugger this long after a tab's last command, so Chrome's
// "started debugging this browser" bar goes away between jobs.
const IDLE_DETACH_MS = 30_000;

let port = null;
const attached = new Map(); // tabId -> idle-detach timer
// Cross-origin iframes run in their own process, so the tab's debugger session
// can't see into them: a payments form in one (Google Play's signup, 10 Nov)
// snapped as a bare [dialog]. Chrome attaches us to each one as a child
// session once asked (Target.setAutoAttach), and commands for it go with its
// sessionId. tabId -> Map(sessionId -> { targetId, url, parent sessionId })
const frameSessions = new Map();
const autoAttached = new Set(); // tabIds whose session has asked for them
const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: 'iframe' }] };
// How far the chain to the Mac gets, for the setup page. An error is kept
// through the 2 s retries until the host really answers, so the page doesn't
// flicker between "checking" and "missing".
const link = { host: 'connecting', error: null, service: false, profile: null };

// Which window is BrowserBear's, which is yours, and which tabs were handed
// over live in chrome.storage.session, which forgets everything when the
// extension reloads (browserbear reload, an update), not only when Chrome
// quits. On 6 Nov another thread's reload landed partway through an agent's
// job on the Convex dashboard: the extension forgot its own window, so the
// tab the agent had opened there counted as Mike's and every click after it
// was refused. So they're copied to local storage as they change and put back
// when the worker starts with none. Window and tab ids only mean something
// until Chrome quits, so a new Chrome session drops them, and anything that
// has since gone is left out. Known gap: an extension disabled across a
// Chrome restart misses onStartup, so if Chrome reused the old window's id
// for one of yours, that window would count as BrowserBear's until it closes.
// Rare enough, and this only guards against agents' mistakes.
const KEPT = ['bearWindow', 'userWindow', 'handedOff'];

// Only what the session holds when the copy runs: these are never taken out of
// the session while they still mean something, so a wipe mustn't be copied
// too, nor a value forgetLastRun has dropped since it changed.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session' || !KEPT.some((k) => changes[k]?.newValue !== undefined)) return;
  queue(async () => {
    const { kept = {} } = await chrome.storage.local.get('kept');
    await chrome.storage.local.set({ kept: { ...kept, ...(await chrome.storage.session.get(KEPT)) } });
  });
});

async function restoreKept() {
  if (Object.keys(await chrome.storage.session.get(KEPT)).length) return {};
  const { kept } = await chrome.storage.local.get('kept');
  if (!kept) return;
  const back = {};
  for (const k of ['bearWindow', 'userWindow']) {
    if (kept[k] && (await chrome.windows.get(kept[k]).catch(() => null))) back[k] = kept[k];
  }
  const open = new Set((await chrome.tabs.query({})).map((t) => t.id));
  const handedOff = (kept.handedOff || []).filter((id) => open.has(id));
  if (handedOff.length) back.handedOff = handedOff;
  if (Object.keys(back).length) await chrome.storage.session.set(back);
  return back;
}

// Ops and the focus listener wait for this, so none of them reads an empty
// session in the moment after a reload. Writes to the copy queue on it too, so
// two quick changes can't each overwrite the other.
const putBack = restoreKept().catch((e) => console.warn('browserbear: cannot restore state', e));
let restored = putBack;
const queue = (job) => (restored = restored.then(job).catch((e) => console.warn('browserbear: cannot keep state', e)));

// Chrome just started, so what was put back (back) is from its last run, and
// its ids may now belong to the user's windows and tabs. Only that goes: an
// agent may already have opened a tab this time.
async function forgetLastRun(back) {
  const now = await chrome.storage.session.get(KEPT);
  const stale = Object.keys(back).filter((k) => JSON.stringify(now[k]) === JSON.stringify(back[k]));
  for (const k of stale) delete now[k];
  await chrome.storage.session.remove(stale);
  await chrome.storage.local.set({ kept: now });
}
chrome.runtime.onStartup.addListener(() => queue(async () => forgetLastRun((await putBack) || {})));

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
  post({ type: 'hello', instance, email: user.email || null, version: chrome.runtime.getManifest().version, panelPopups: true, screencast: true });
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
    if (!msg.up) { link.profile = null; stopCasts(); }
    return;
  }
  // From the service, after our hello: the name agents will use for us.
  if (msg.type === 'welcome') {
    // A service that just started has no panel watching any cast of ours.
    stopCasts();
    Object.assign(link, { host: 'up', error: null, service: true, profile: { name: msg.name || null, email: msg.email || null, dir: msg.dir || null } });
    return;
  }
  if (msg.type) return; // some other notice from a newer host or service
  const handler = ops[msg.op];
  try {
    if (!handler) throw new Error(`unknown op ${msg.op}`);
    await restored;
    post({ id: msg.id, ok: true, result: await handler(msg.args || {}) });
  } catch (e) {
    post({ id: msg.id, ok: false, error: String(e?.message || e) });
  }
}

// Why the page in a tab didn't load, for the service to tell agents: Chrome
// keeps debuggers out of its warning pages, so this is the only place that can
// say what went wrong. Only counts while the tab is still on the failed URL.
const loadErrors = new Map(); // tabId -> { url, error }

chrome.webNavigation.onBeforeNavigate.addListener(({ tabId, frameId }) => {
  if (frameId === 0) loadErrors.delete(tabId);
});

chrome.webNavigation.onErrorOccurred.addListener(({ tabId, frameId, url, error }) => {
  // ERR_ABORTED isn't a failure: a download, or another navigation took over.
  if (frameId === 0 && error !== 'net::ERR_ABORTED') loadErrors.set(tabId, { url, error });
});

const loadError = (t) => {
  const failed = loadErrors.get(t.id);
  return failed && failed.url === t.url ? failed.error : undefined;
};

const tabInfo = (t) => ({
  tabId: t.id,
  windowId: t.windowId,
  openerTabId: t.openerTabId,
  url: t.url || t.pendingUrl || '',
  // Without the mark's "🐻 name · ", so agents see the page's own title.
  title: (t.title || '').replace(MARK_PREFIX, ''),
  active: t.active,
  groupId: t.groupId,
  status: t.status,
  loadError: loadError(t),
});

// Which window is yours, as opposed to BrowserBear's own: the one you last had in
// front. Kept in session storage because this worker sleeps between jobs;
// the listener below wakes it for each focus change.
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  await restored;
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
    return tabs.map((t) => ({ ...tabInfo(t), agent: t.windowId === bearWindow || handedOff.includes(t.id), bear: t.windowId === bearWindow }));
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

  // Navigates without the debugger, which Chrome won't attach to a tab on one
  // of its warning pages: the way out of a certificate error.
  async navigate({ tabId, url }) {
    // The old page counts as loaded until the new one starts, so wait for
    // that first. A URL that only downloads never starts loading.
    const started = new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      };
      const listener = (id, change) => {
        if (id === tabId && change.status === 'loading') finish();
      };
      const timer = setTimeout(finish, 5_000);
      chrome.tabs.onUpdated.addListener(listener);
    });
    await chrome.tabs.update(tabId, { url });
    await started;
    return tabInfo(await waitForLoad(tabId));
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
    // Not yet idle from the agent's last command, the debugger would keep
    // Chrome's bar across the page you're about to use, and Chrome cuts it off
    // anyway when your password manager's menu appears.
    await detach(tabId);
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

  // What `handoff --wait` asks about a tab you're working in. Through
  // scripting rather than the debugger, which would put Chrome's bar up and
  // clear your password manager's menu while you sign in. Says only yes or no:
  // nothing from the page comes back. Every frame, as sign-ins and card forms
  // are often in one. A page that can't be scripted gives null, not "no".
  async probe({ tabId, text }) {
    const frames = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: probePage, args: [text ?? null] }).catch(() => []);
    if (!frames.length) return { signInForm: null, text: false };
    return { signInForm: frames.some((f) => f.result?.signInForm), text: frames.some((f) => f.result?.text) };
  },

  async focus({ tabId }) {
    const tab = await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return tabInfo(tab);
  },

  async cdp({ tabId, method, params, sessionId }) {
    // A screencast shows the page as it draws, so the pill stays out of it
    // for as long as the cast runs, not just around one command.
    if (method === 'Page.startScreencast') { casting.add(tabId); await hideMark(tabId); }
    if (method === 'Page.stopScreencast') casting.delete(tabId);
    if (COVERED.test(method)) await hideMark(tabId);
    try {
      await attach(tabId);
      return await chrome.debugger.sendCommand(sessionId ? { tabId, sessionId } : { tabId }, method, params || {});
    } catch (e) {
      const message = String(e?.message);
      const refused = message.includes('URL of different extension');
      if (!refused && !message.includes('Detached while handling command')) throw e;
      // Another extension's frame is in the tab, and Chrome won't let a
      // debugger near a tab that has one: it cut us off when the frame came
      // (1Password's menu on focusing an address field, passport.service.gov.uk,
      // 30 Oct), and refuses to attach again while it's there.
      const blocking = await blankExtensionFrames(tabId);
      // A detach with no such frame is the tab closing or the like.
      if (!refused && !blocking.length) throw e;
      const who = `another extension's frame (${blocking.join(', ')}; a password manager's menu, usually)`;
      // A command Chrome cut off may already have run (typed text, a
      // click), so it isn't sent again; one that was refused never ran.
      if (!refused) throw new Error(`${who} appeared mid-command and Chrome detached BrowserBear. It's cleared now; snap to see whether the command ran`);
      // For one of the tab's iframes: getting back in starts a new tab session,
      // which ends that frame's one. "session" has the service ask for frames
      // again and send it once more.
      if (sessionId) {
        await attach(tabId).catch(() => {});
        throw new Error(`${who} was cleared, which ended the frame's debugger session`);
      }
      try {
        // Even with nothing found: the frame may have gone by itself already.
        await attach(tabId);
        return await chrome.debugger.sendCommand({ tabId }, method, params || {});
      } catch (again) {
        // Chrome's own wording reads as if the command were wrong or the tab
        // broken, when the page is fine and BrowserBear just can't reach it.
        if (!blocking.length) throw new Error(`Chrome won't let BrowserBear into tab ${tabId} because another extension (a password manager, usually) has a frame in it, and BrowserBear couldn't find the frame to clear it. The page itself is fine; try again, or browserbear handoff ${tabId} if a person can do this step`);
        throw new Error(`${who} is in tab ${tabId} and Chrome won't let BrowserBear in while it's there; clearing it didn't stick (${again?.message}). The page itself is fine`);
      }
    } finally {
      if (COVERED.test(method) || method === 'Page.stopScreencast') showMarkSoon(tabId);
    }
  },

  // The tab's cross-origin iframes, each with the sessionId cdp takes for it.
  async frames({ tabId }) {
    await attach(tabId);
    if (!autoAttached.has(tabId)) {
      autoAttached.add(tabId);
      try {
        await chrome.debugger.sendCommand({ tabId }, 'Target.setAutoAttach', AUTO_ATTACH);
      } catch (e) {
        autoAttached.delete(tabId);
        throw e;
      }
      // The frames already there arrive as events just after.
      await new Promise((r) => setTimeout(r, 150));
    }
    return [...(frameSessions.get(tabId) || [])].map(([sessionId, f]) => ({ sessionId, ...f }));
  },

  // Draws (or, with no mark, takes off) the marks on an agent's tab; the
  // service decides what they say (service/marks.mjs).
  async mark({ tabId, mark }) {
    await chrome.tabs.get(tabId); // "No tab with id" tells the service it's gone
    const all = await markStore();
    if (mark) all[tabId] = mark;
    else delete all[tabId];
    await chrome.storage.session.set({ marks: all });
    await paint(tabId, mark);
    return true;
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

// ---- Marks on agents' tabs ----
// The tab's title becomes "🐻 thread · page title" and its icon gets a dot,
// so you can tell agents' tabs apart in the tab strip; in the page a pill
// says what the agent is doing, with Open thread, Stop and ✕ (leave this
// tab alone). Kept in session storage so a tab that navigates gets them
// back, even after this worker has slept.
const MARK_PREFIX = /^🐻 [^·]{1,40} · /;
const DOTS = { working: '#22c55e', yours: '#f59e0b', idle: '#9ca3af' };

let marks = null;
async function markStore() {
  marks ||= (await chrome.storage.session.get('marks')).marks || {};
  return marks;
}

async function paint(tabId, mark) {
  const icon = mark ? await badgedIcon(tabId, mark.state).catch(() => null) : null;
  // Pages extensions can't script (the Web Store, chrome://) go unmarked.
  await chrome.scripting.executeScript({ target: { tabId }, func: drawMark, args: [mark, icon] }).catch(() => {});
}

// A page that navigates loses what was drawn on it.
chrome.tabs.onUpdated.addListener(async (tabId, change) => {
  if (change.status !== 'complete') return;
  const mark = (await markStore())[tabId];
  if (!mark) return;
  await paint(tabId, mark);
  // The new page's pill is drawn showing. If it's meant to be out of the
  // way (a cast to the Browser panel, a click), put it back out of the way.
  if (showTimers.has(tabId)) await setMarkHidden(tabId, true);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  loadErrors.delete(tabId);
  const all = await markStore();
  if (!(tabId in all)) return;
  delete all[tabId];
  await chrome.storage.session.set({ marks: all });
});

// The pill's buttons.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (sender.id !== chrome.runtime.id || msg?.type !== 'mark-action' || !sender.tab) return;
  const tab = sender.tab;
  if (msg.action === 'release') ops.mark({ tabId: tab.id, mark: null }).catch(() => {});
  // The service opens the thread in Threadbear's Mac app (Chrome would ask first).
  if (['open', 'stop', 'release', 'done'].includes(msg.action)) post({ type: 'event', event: 'mark', action: msg.action, tabId: tab.id });
});

// The pill is in the page, so it would catch an agent's real clicks (and
// the check for what's on top of the target) and be in its screenshots: it
// steps aside for those commands and comes back just after.
const COVERED = /^(Input\.|DOM\.getNodeForLocation$|Page\.captureScreenshot$)/;
const showTimers = new Map();
const casting = new Set(); // tabs streaming to Threadbear's Browser panel

// The service went away without stopping its casts (it crashed, or was
// killed): a still page sends no frames to notice that by, and a cast keeps
// the tab attached and its pill hidden.
function stopCasts() {
  for (const tabId of casting) {
    casting.delete(tabId);
    chrome.debugger.sendCommand({ tabId }, 'Page.stopScreencast').catch(() => {});
    showMarkSoon(tabId);
  }
}

async function hideMark(tabId) {
  if (!(tabId in (await markStore()))) return;
  const wasShowing = !showTimers.has(tabId);
  clearTimeout(showTimers.get(tabId));
  showTimers.set(tabId, null);
  if (wasShowing) await setMarkHidden(tabId, true);
}

function showMarkSoon(tabId) {
  if (!showTimers.has(tabId) || casting.has(tabId)) return;
  clearTimeout(showTimers.get(tabId));
  showTimers.set(tabId, setTimeout(() => {
    showTimers.delete(tabId);
    setMarkHidden(tabId, false);
  }, 600));
}

function setMarkHidden(tabId, hidden) {
  return chrome.scripting
    .executeScript({ target: { tabId }, func: (h) => window.__browserbearMark?.hide(h), args: [hidden] })
    .catch(() => {});
}

// The page's own icon with the state's dot on it, as a data URL. Fetched
// here rather than in the page, where another site's icon can't be drawn
// onto a canvas and read back.
const icons = new Map(); // "href|state" -> data URL
async function badgedIcon(tabId, state) {
  const [{ result: href } = {}] = await chrome.scripting.executeScript({ target: { tabId }, func: siteIcon });
  const key = `${href}|${state}`;
  if (icons.has(key)) return icons.get(key);
  let bitmap = null;
  try {
    const res = await fetch(href);
    if (res.ok) bitmap = await createImageBitmap(await res.blob());
  } catch {} // no icon, or an SVG, which a worker can't decode
  bitmap ||= await createImageBitmap(await (await fetch(chrome.runtime.getURL('icons/icon-32.png'))).blob());
  const canvas = new OffscreenCanvas(32, 32);
  const g = canvas.getContext('2d');
  g.drawImage(bitmap, 0, 0, 32, 32);
  g.beginPath();
  g.arc(24, 24, 8, 0, Math.PI * 2);
  g.fillStyle = '#fff';
  g.fill();
  g.beginPath();
  g.arc(24, 24, 6, 0, Math.PI * 2);
  g.fillStyle = DOTS[state] || DOTS.idle;
  g.fill();
  const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const url = `data:image/png;base64,${btoa(bin)}`;
  icons.set(key, url);
  return url;
}

// Runs in the page. Only fields you can see: sites hide spare password fields
// (Google's first sign-in step has one). Text matches as you'd read it, whatever
// its case or line breaks.
function probePage(text) {
  const tidy = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const fields = document.querySelectorAll('input[type=password], input[autocomplete="one-time-code"]');
  return {
    signInForm: [...fields].some((f) => f.checkVisibility()),
    text: text != null && tidy(document.body?.innerText || '').includes(tidy(text)),
  };
}

// Runs in the page. The site's icon, before the mark replaced it.
function siteIcon() {
  const saved = window.__browserbearMark?.siteIcon;
  const link = document.querySelector('link[rel~="icon" i]:not([data-browserbear]), link[rel="browserbear-icon"]');
  return saved || link?.href || new URL('/favicon.ico', location.href).href;
}

// Runs in the page (the extension's isolated world, which shares the DOM):
// draws the mark, keeps the title and icon ours while the site changes its
// own, and with no mark puts everything back.
function drawMark(mark, icon) {
  const PREFIX = /^🐻 [^·]{1,40} · /;
  let m = window.__browserbearMark;
  if (!m && !mark) return;
  if (!m) {
    // Leftovers from before the extension reloaded, whose scripts can't be
    // reached any more (and stop themselves: see enforce).
    document.querySelectorAll('browserbear-mark, link[data-browserbear]').forEach((el) => el.remove());
    m = window.__browserbearMark = { siteTitle: document.title.replace(PREFIX, ''), saved: [], hidden: false };
    for (const l of document.querySelectorAll('link[rel="browserbear-icon"]')) m.saved.push([l, 'icon']);

    m.host = document.createElement('browserbear-mark');
    // Out of the accessibility tree, so agents' snapshots don't see it.
    m.host.setAttribute('aria-hidden', 'true');
    m.host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647';
    const root = m.host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>
      :host{all:initial}
      .glow{position:fixed;inset:0;pointer-events:none;transition:box-shadow .3s}
      .pill{position:fixed;top:12px;right:12px;display:flex;align-items:center;gap:8px;max-width:min(560px,calc(100vw - 24px));
        padding:6px 6px 6px 12px;border-radius:999px;background:#111827;color:#e5e7eb;pointer-events:auto;
        font:13px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.25);opacity:.96}
      .dot{width:8px;height:8px;border-radius:50%;flex:none}
      .working .dot{animation:pulse 1.4s ease-in-out infinite}
      .pill.thanks{background:#15803d;color:#fff;padding-right:12px}
      .pill.thanks .dot{background:#fff !important;animation:none}
      .fading{animation:fade .7s ease 2.2s forwards}
      @keyframes fade{to{opacity:0}}
      button.done{background:#16a34a}
      button.done:hover{background:#22c55e}
      @keyframes pulse{50%{box-shadow:0 0 0 5px rgba(34,197,94,.25)}}
      .text{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .text b{color:#fff;font-weight:600}
      button{all:unset;cursor:pointer;padding:4px 10px;border-radius:999px;background:#374151;color:#fff;font-size:12px;white-space:nowrap}
      button:hover{background:#4b5563}
      .x{padding:4px 7px;background:none;color:#9ca3af}
      .idle{padding-top:4px;padding-bottom:4px;opacity:.85}
    </style><div class=glow></div><div class=pill><i class=dot></i><span class=text></span>
      <button class=done title="I've finished here, carry on">Done</button><button class=open>Open thread</button><button class=stop>Stop</button><button class=x title="Leave this tab alone">✕</button></div>`;
    const $ = (sel) => root.querySelector(sel);
    m.parts = { glow: $('.glow'), pill: $('.pill'), dot: $('.dot'), text: $('.text'), open: $('.open'), stop: $('.stop'), done: $('.done') };
    const send = (action) => chrome.runtime.sendMessage({ type: 'mark-action', action }).catch(() => {});
    $('.open').onclick = () => send('open');
    $('.stop').onclick = () => send('stop');
    $('.done').onclick = () => send('done');
    $('.x').onclick = () => send('release');

    m.hide = (hidden) => {
      m.hidden = hidden;
      m.host.style.display = hidden ? 'none' : '';
    };
    // Sites change their title and icon (Gmail's unread count): the page's
    // new one is kept for later and ours put back.
    m.enforce = () => {
      // A script from before the extension reloaded: it can't reach the
      // extension any more, so it bows out rather than fight the new one.
      if (!chrome.runtime?.id) return m.observer.disconnect();
      if (!m.mark) return;
      if (!PREFIX.test(document.title)) m.siteTitle = document.title;
      const title = `🐻 ${m.mark.name} · ${m.siteTitle}`;
      if (document.title !== title) document.title = title;
      for (const l of document.querySelectorAll('link[rel~="icon" i]:not([data-browserbear])')) {
        m.saved.push([l, l.rel]);
        m.siteIcon = l.href;
        l.rel = 'browserbear-icon';
      }
      if (m.icon && !m.iconLink?.isConnected) {
        m.iconLink = Object.assign(document.createElement('link'), { rel: 'icon', href: m.icon });
        m.iconLink.dataset.browserbear = '';
        (document.head || document.documentElement).append(m.iconLink);
      }
      if (!m.host.isConnected) document.documentElement.append(m.host);
    };
    m.observer = new MutationObserver(() => m.enforce());
  }

  if (!mark) {
    m.observer.disconnect();
    m.host.remove();
    m.iconLink?.remove();
    for (const [l, rel] of m.saved) l.rel = rel;
    if (PREFIX.test(document.title)) document.title = m.siteTitle;
    delete window.__browserbearMark;
    return;
  }

  m.mark = mark;
  m.icon = icon;
  if (m.iconLink && m.iconLink.href !== icon) {
    m.iconLink.remove();
    m.iconLink = null;
  }
  const colour = { working: '#22c55e', yours: '#f59e0b', idle: '#9ca3af' }[mark.state] || '#9ca3af';
  const p = m.parts;
  p.pill.className = `pill ${mark.state}${mark.thanks ? ' thanks fading' : ''}`;
  p.glow.className = `glow${mark.thanks ? ' fading' : ''}`;
  p.dot.style.background = colour;
  p.text.textContent = '';
  p.text.append('🐻 ', Object.assign(document.createElement('b'), { textContent: mark.name }), ` · ${mark.action}`);
  p.open.style.display = mark.url ? '' : 'none';
  p.stop.style.display = mark.stop ? '' : 'none';
  p.done.style.display = mark.finish ? '' : 'none';
  // The glow only while it's busy or waiting on you; an idle tab just keeps the small pill.
  p.glow.style.boxShadow = mark.state === 'idle' ? 'none' : `inset 0 0 0 3px ${colour}, inset 0 0 24px ${colour}55`;
  m.observer.disconnect();
  m.enforce();
  m.observer.observe(document.documentElement, { childList: true });
  if (document.head) m.observer.observe(document.head, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['rel', 'href'] });
}

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
    forgetFrames(tabId);
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
  // A cast of a page that isn't changing sends no frames, and so no acks:
  // that's not idle.
  attached.set(tabId, setTimeout(() => (casting.has(tabId) ? attach(tabId) : detach(tabId)), IDLE_DETACH_MS));
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
        // chrome.dom throws on anything that isn't an HTML element, and one
        // svg on the page would then lose the whole scan, leaving the tab
        // locked (BTC Markets' sign-in page, 1 Nov).
        const shadowOf = (el) => (el instanceof HTMLElement && chrome.dom?.openOrClosedShadowRoot?.(el)) || el.shadowRoot;
        const visit = (root) => {
          for (const el of root.querySelectorAll('*')) {
            const shadow = shadowOf(el);
            if (shadow) visit(shadow);
            if (!['IFRAME', 'FRAME', 'EMBED', 'OBJECT'].includes(el.tagName)) continue;
            const m = /^chrome-extension:\/\/([a-p]{32})/.exec(el.src || el.data || '');
            // 1Password's sign-on frame says about:blank, then sends itself to its
            // own page, so its src gives nothing away (auth.convex.dev, 2 Nov). A
            // really blank frame shares our origin; that one's document is shut to us.
            const moved = el.tagName === 'IFRAME' && /^(about:blank)?$/.test(el.src) && el.contentDocument === null;
            if (m ? m[1] === self : !moved) continue;
            ids.push(m ? m[1] : 'a frame hiding its address');
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

function forgetFrames(tabId) {
  frameSessions.delete(tabId);
  autoAttached.delete(tabId);
}

async function detach(tabId) {
  forgetFrames(tabId);
  clearTimeout(attached.get(tabId));
  // Our own detach ends a cast without an onDetach.
  if (casting.delete(tabId)) showMarkSoon(tabId);
  if (!attached.delete(tabId)) return;
  await chrome.debugger.detach({ tabId }).catch(() => {});
}

chrome.debugger.onDetach.addListener(({ tabId }, reason) => {
  forgetFrames(tabId);
  casting.delete(tabId);
  showMarkSoon(tabId);
  clearTimeout(attached.get(tabId));
  attached.delete(tabId);
  post({ type: 'event', event: 'detached', tabId, reason });
});

chrome.debugger.onEvent.addListener(({ tabId, sessionId }, method, params) => {
  if (method === 'Target.attachedToTarget' && params.targetInfo?.type === 'iframe') {
    if (!frameSessions.has(tabId)) frameSessions.set(tabId, new Map());
    const { targetId, url } = params.targetInfo;
    frameSessions.get(tabId).set(params.sessionId, { targetId, url, parent: sessionId || null });
    // A cross-origin frame inside that one (reCAPTCHA in a payments form).
    chrome.debugger.sendCommand({ tabId, sessionId: params.sessionId }, 'Target.setAutoAttach', AUTO_ATTACH).catch(() => {});
    return;
  }
  if (method === 'Target.detachedFromTarget') {
    frameSessions.get(tabId)?.delete(params.sessionId);
    return;
  }
  // The rest is about the tab itself, not one of its frames.
  if (sessionId) return;
  // Only what the service needs to know about; everything else stays here.
  if (method === 'Page.javascriptDialogOpening') post({ type: 'event', event: 'dialog', tabId, params });
  if (method === 'Page.javascriptDialogClosed') post({ type: 'event', event: 'dialogClosed', tabId });
  // The Browser panel's picture. Chrome sends the next one once the service
  // acks this one, so a slow panel gets fewer frames, not a queue.
  if (method === 'Page.screencastFrame' && casting.has(tabId)) post({ type: 'event', event: 'frame', tabId, params: { data: params.data, sessionId: params.sessionId } });
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
