// Threadbear's Browser panel: a list of a thread's pages, each with a still of
// the page and a button that brings its real window forward. Since 8 Nov 2026
// the panel doesn't stream pages or send input into them: Mike didn't like a
// page mirrored into Threadbear, so the pages live in real windows (the agents'
// browser, agent/agent-host.mjs, or BrowserBear's window in his own Chrome).
// It all goes over the same private socket as the CLI, and only the thread a
// page belongs to can see its still or bring it forward.
import fs from 'node:fs';
import path from 'node:path';

const AGENT = 'agent-chrome';
// How old a still can be before the panel's next ask takes a new one. The
// agents' browser takes one in about 40 ms. A page in Mike's own Chrome goes
// through the extension's debugger, which keeps Chrome's "started debugging"
// bar up, so those are taken far less often, and never once he has the tab.
const FRESH_MS = { agent: 3_000, chrome: 20_000 };

export function createPanel({ home, profiles, call, mark, beforeStill = async () => {} }) {
  const file = path.join(home, 'panel-tabs.json');
  let saved = [];
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const key = (instance, tabId) => `${instance}/${tabId}`;
  const tabs = new Map((Array.isArray(saved) ? saved : []).filter(t => t.instance && t.tabId != null)
    .map(t => [key(t.instance, t.tabId), { tabId: t.tabId, thread: t.thread, instance: t.instance, openedAt: t.openedAt || Date.now(), handoffs: t.handoffs || 0, handoffAt: t.handoffAt }]));
  const stills = new Map(); // key -> { data, at } or a promise of one
  const persist = () => {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify([...tabs.values()]), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  };
  const profileFor = t => profiles().find(p => p.instance === t.instance);
  // The thread's own page, with the exact profile it's in: the same tab number
  // can be in the agents' browser and in one of Mike's profiles.
  const ownTab = (thread, tabId, instance) => {
    const own = tabs.get(key(instance || AGENT, Number(tabId)));
    if (!thread || !own || own.thread !== thread) throw new Error('This page belongs to another thread, or is no longer open.');
    const profile = profileFor(own);
    if (!profile) throw new Error('This browser profile is not connected to BrowserBear.');
    return { own, profile };
  };

  function remember(tabId, thread, instance, fresh = false) {
    if (!thread) return;
    const previous = tabs.get(key(instance, tabId));
    if (!fresh && previous?.thread === thread) return;
    tabs.set(key(instance, tabId), { tabId, thread, instance, openedAt: Date.now(), handoffs: previous?.handoffs || 0 });
    stills.delete(key(instance, tabId));
    persist();
  }

  async function state() {
    const rows = await Promise.all(profiles().map(async p => {
      const list = await call(p, 'tabs', {}, 5_000).catch(() => null);
      if (!list) return [];
      const byId = new Map(list.map(t => [t.tabId, t]));
      const out = [];
      for (const own of tabs.values()) {
        if (own.instance !== p.instance) continue;
        const tab = byId.get(own.tabId);
        if (!tab) { tabs.delete(key(own.instance, own.tabId)); stills.delete(key(own.instance, own.tabId)); continue; }
        const m = mark(own.tabId) || {};
        out.push({ tabId: own.tabId, url: tab.url, title: tab.title, status: tab.status, thread: own.thread, openedAt: own.openedAt,
          handoffs: own.handoffs, handoffAt: own.handoffAt, profile: p.instance, profileName: p.name || p.dir || p.instance.slice(0, 8),
          profileEmail: p.email, bridge: p.instance !== AGENT, state: m.state, action: m.action, finish: m.finish });
      }
      return out;
    }));
    return { profiles: profiles().filter(p => p.instance !== AGENT).map(p => ({ id: p.instance, name: p.name, email: p.email })), tabs: rows.flat() };
  }

  async function takeStill(own, profile, width) {
    await beforeStill(own.tabId).catch(() => {});
    if (profile.instance === AGENT) return call(profile, 'still', { tabId: own.tabId, width }, 10_000);
    const metrics = await call(profile, 'cdp', { tabId: own.tabId, method: 'Page.getLayoutMetrics', params: {} }, 5_000);
    const view = metrics.cssVisualViewport || metrics.visualViewport;
    const scale = Math.min(1, width / view.clientWidth);
    const { data } = await call(profile, 'cdp', { tabId: own.tabId, method: 'Page.captureScreenshot', params: {
      format: 'jpeg', quality: 60, clip: { x: view.pageX, y: view.pageY, width: view.clientWidth, height: view.clientHeight, scale },
    } }, 6_000);
    return { data, at: Date.now() };
  }

  async function still(thread, { tab, profile: instance, width }) {
    const { own, profile } = ownTab(thread, tab, instance);
    const id = key(own.instance, own.tabId);
    const have = stills.get(id);
    if (have?.then) return have;
    const agent = own.instance === AGENT;
    // Mike's own tab, handed to him: no debugger on it while he signs in.
    if (!agent && own.handoffs > 0 && mark(own.tabId)?.state === 'yours') return have || { data: null, at: null };
    if (have && Date.now() - have.at < (agent ? FRESH_MS.agent : FRESH_MS.chrome)) return have;
    const size = Math.max(160, Math.min(800, Number(width) || 480));
    const taking = takeStill(own, profile, size).then(
      s => { stills.set(id, s); return s; },
      // A page that can't be drawn just now (Chrome doesn't draw a background
      // tab) keeps its last still, or shows none.
      () => { if (have) stills.set(id, have); else stills.delete(id); return have || { data: null, at: null }; },
    );
    stills.set(id, taking);
    return taking;
  }

  // Show window: the page's real window comes to the front.
  async function show(thread, { tab, profile: instance }) {
    const { own, profile } = ownTab(thread, tab, instance);
    await call(profile, 'focus', { tabId: own.tabId }, 10_000);
    return {};
  }

  return { remember, state,
    handedOff(tabId, instance) {
      const t = tabs.get(key(instance, tabId));
      if (t) { t.handoffs++; t.handoffAt = Date.now(); persist(); }
    },
    forget(tabId, instance) { tabs.delete(key(instance, tabId)); stills.delete(key(instance, tabId)); persist(); },
    dispatch(conn, msg) {
      const args = msg.args || {};
      if (msg.cmd === 'panelStill') return still(msg.thread, args);
      if (msg.cmd === 'panelShow') return show(msg.thread, args);
      throw new Error('This Browser panel is from an older Threadbear: update it to see this thread\'s pages.');
    },
    disconnected(instance) {
      for (const own of tabs.values()) if (own.instance === instance) stills.delete(key(instance, own.tabId));
    },
  };
}
