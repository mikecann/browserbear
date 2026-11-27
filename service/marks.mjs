// Which agent has which tab, so the extension can mark it: the thread's name
// in front of the tab's title, a dot on its icon and a pill in the page.
// Green is working, amber is waiting for you (handed off), grey is a thread
// that still has the tab but isn't using it right now. Mike shares Chrome
// with every agent and couldn't tell their tabs from his (30 Oct); tab groups
// did that before, but Chrome kept every one on the bookmarks bar.
//
// Marks come off when the thread's turn ends without needing you, or the
// thread is archived. Names and states come from Threadbear's `tb list`;
// without Threadbear the tab just says "agent" and clears after two quiet
// minutes.
import { tbPath, run } from './threadbear.mjs';

// Env vars so tests needn't wait.
const WORKING_MS = Number(process.env.BROWSERBEAR_WORKING_MS) || 12_000;
const TICK_MS = Number(process.env.BROWSERBEAR_MARK_TICK_MS) || 4_000;
const LONE_MS = 120_000;
// How long since a `handoff --wait` last looked before it counts as gone.
const WAIT_SEEN_MS = 10_000;
// The green "Thanks" before the marks come off. The pill's own fade (drawMark
// in extension/background.js) finishes just before this.
const THANKS_MS = Number(process.env.BROWSERBEAR_THANKS_MS) || 3_000;

// Short enough to leave room for the page's own title; no "·", which
// separates the name from the title.
const shortName = (title) => {
  const t = title.replace(/·/g, '-').trim();
  return t.length > 24 ? `${t.slice(0, 23).trimEnd()}…` : t;
};

// send(tabId, mark | null) draws or clears a tab's marks; it rejects with
// "No tab with id" once the tab is gone.
export function createMarks({ send, log, tickMs = TICK_MS }) {
  const claims = new Map(); // tabId -> { thread, action, at, busy, yours, sent, waitSeen, doneClicked, thanks }
  const released = new Set(); // tabs you pressed ✕ on, which a wait mustn't mark again
  let threads = null; // id -> thread, from tb list; null until it first answers
  let threadsAt = 0;
  let site; // the Threadbear website, where "Open thread" goes without the Mac app; null if there isn't one
  let loading = null;

  function refreshThreads() {
    const tb = tbPath();
    if (!tb || Date.now() - threadsAt < TICK_MS * 2) return Promise.resolve();
    loading ||= (async () => {
      const out = await run(tb, ['list', '--json']);
      try {
        if (out) threads = new Map(JSON.parse(out).map((t) => [t.id, t]));
      } catch {}
      threadsAt = Date.now();
      if (site === undefined) {
        // Its Convex deployment: the website is the same name on .convex.site.
        const m = /(https:\/\/[\w.-]+)\.convex\.cloud/.exec((await run(tb, ['status'])) || '');
        site = m ? `${m[1]}.convex.site` : null;
      }
    })().finally(() => (loading = null));
    return loading;
  }

  function markFor(c) {
    const now = Date.now();
    const working = c.busy > 0 || now - c.at < WORKING_MS;
    const t = c.thread && threads?.get(c.thread);
    if (c.thread && threads && !t) return null; // archived, or deleted
    // The pill's Open thread: the Mac app's link (Threadbear's ThreadLink).
    const base = { name: t ? shortName(t.title) : 'agent', url: t ? `threadbear://thread/${t.id}` : null };
    // State "working" for its green, so a store build older than `thanks` still goes green.
    if (c.thanks) return now - c.thanks < THANKS_MS ? { ...base, url: null, state: 'working', action: 'Thanks, carrying on', stop: false, thanks: true } : null;
    // An agent waiting in the background has ended its turn, so the thread can
    // look done with the tab when it isn't. `finish` is the pill's Done button.
    if (c.yours && now - (c.waitSeen || 0) < WAIT_SEEN_MS) return { ...base, state: 'yours', action: 'over to you', stop: false, finish: true };
    if (t) {
      const running = t.status === 'running';
      const needsYou = !running && (t.needsYou || t.needs === 'you');
      if (c.yours) return running || needsYou ? { ...base, state: 'yours', action: 'over to you', stop: false } : null;
      if (working) return { ...base, state: 'working', action: c.action, stop: running };
      if (running) return { ...base, state: 'idle', action: 'thinking', stop: true };
      if (needsYou) return { ...base, state: 'idle', action: 'waiting for you in its thread', stop: false };
      return null; // the turn ended and nothing waits on you: done with the tab
    }
    if (now - c.at > LONE_MS) return null;
    if (c.yours) return { ...base, state: 'yours', action: 'over to you', stop: false };
    return { ...base, state: working ? 'working' : 'idle', action: working ? c.action : 'quiet', stop: false };
  }

  async function push(tabId) {
    const c = claims.get(tabId);
    if (!c) return;
    // One in-flight mark RPC per tab; concurrent calls coalesce instead of
    // piling up on a slow/stuck tab when send() takes longer than tickMs.
    if (c.sending) {
      c.dirty = true;
      return c.sending;
    }
    let active = true;
    const run = (async () => {
      try {
      do {
        c.dirty = false;
        const mark = markFor(c);
        const key = JSON.stringify(mark);
        if (key !== c.sent) {
          if (c.retryAt && Date.now() < c.retryAt) return;
          try {
            await send(tabId, mark);
            c.sent = key;
            c.fails = 0;
            c.retryAt = 0;
          } catch (e) {
            if (/no tab/i.test(e.message)) {
              claims.delete(tabId);
            } else {
              c.fails = (c.fails || 0) + 1;
              c.retryAt = Date.now() + Math.min(60_000, tickMs * 2 ** Math.min(c.fails - 1, 10));
              log('mark failed', tabId, e.message); // an older extension, or a page that won't take scripts
            }
            return;
          }
        }
      } while (claims.get(tabId) === c && (c.dirty || JSON.stringify(markFor(c)) !== c.sent));
      if (c.sent === 'null' && claims.get(tabId) === c && !c.busy && !markFor(c)) claims.delete(tabId);
      } finally {
        active = false;
        c.sending = null;
      }
    })();
    if (active) c.sending = run;
    return run;
  }

  let ticking = false;
  const tickTimer = setInterval(async () => {
    if (ticking || !claims.size) return;
    ticking = true;
    try {
      await refreshThreads();
      await Promise.allSettled([...claims.keys()].map((tabId) => push(tabId)));
    } finally {
      ticking = false;
    }
  }, tickMs);
  tickTimer.unref();

  function claim(tabId, thread) {
    let c = claims.get(tabId);
    if (!c) claims.set(tabId, (c = { busy: 0, at: 0 }));
    if (thread) c.thread = thread; // another thread picking the tab up takes it over
    return c;
  }

  // A thread's first command waits for nothing: the tab says "agent" until
  // tb list answers, a couple of seconds later.
  const soon = (tabId) => {
    push(tabId);
    refreshThreads().then(() => push(tabId));
  };

  return {
    get(tabId) { const c = claims.get(tabId); return c ? markFor(c) : null; },
    // A command on the tab is starting (begin) or has finished (end).
    begin(tabId, thread, action) {
      const c = claim(tabId, thread);
      Object.assign(c, { busy: c.busy + 1, at: Date.now(), action, yours: false, thanks: 0, doneClicked: false });
      soon(tabId);
    },
    end(tabId) {
      const c = claims.get(tabId);
      if (!c) return;
      c.busy = Math.max(0, c.busy - 1);
      c.at = Date.now();
    },
    used(tabId, thread, action) {
      this.begin(tabId, thread, action);
      this.end(tabId);
    },
    handedOff(tabId, thread) {
      released.delete(tabId);
      Object.assign(claim(tabId, thread), { yours: true, at: Date.now(), thanks: 0, doneClicked: false });
      soon(tabId);
    },
    // A `handoff --wait` is still watching this tab. Marks live in memory, so
    // after a service restart this also puts the bar's claim back.
    waiting(tabId, thread) {
      if (released.has(tabId)) return;
      if (!claims.has(tabId)) Object.assign(claim(tabId, thread), { yours: true, at: Date.now() });
      claims.get(tabId).waitSeen = Date.now();
      soon(tabId);
    },
    // The pill's Done button. The wait hears on its next look.
    clickedDone(tabId) {
      const c = claims.get(tabId);
      if (c) c.doneClicked = true;
    },
    doneClicked: (tabId) => !!claims.get(tabId)?.doneClicked,
    // The wait saw you finish: a moment of green, then the marks come off.
    finished(tabId) {
      const c = claims.get(tabId);
      if (!c) return; // you pressed ✕ on it
      Object.assign(c, { yours: false, waitSeen: 0, doneClicked: false, thanks: Date.now() });
      push(tabId);
      setTimeout(() => push(tabId), THANKS_MS + 50).unref();
    },
    closed(tabId) {
      claims.delete(tabId);
      released.delete(tabId);
    },
    // From the pill's buttons.
    async release(tabId) {
      const prev = claims.get(tabId)?.sending;
      claims.delete(tabId);
      released.add(tabId);
      await send(tabId, null).catch(() => {});
      if (prev) {
        await prev.catch(() => {});
        if (!claims.has(tabId)) await send(tabId, null).catch(() => {});
      }
    },
    // Opens the thread in the Mac app, with `open` rather than from Chrome,
    // which would ask first. An app too old to know the link (or none at
    // all) gets the thread on the website instead.
    async open(tabId) {
      const thread = claims.get(tabId)?.thread;
      if (!thread) return;
      if ((await run('/usr/bin/open', [`threadbear://thread/${thread}`])) !== null) return;
      await refreshThreads();
      if (site) await run('/usr/bin/open', [`${site}/t/${thread}`]);
    },
    async stop(tabId) {
      const c = claims.get(tabId);
      const tb = tbPath();
      if (!c?.thread || !tb) return;
      log('stopping thread', c.thread, 'from tab', tabId);
      await run(tb, ['interrupt', c.thread]);
      threadsAt = 0;
      soon(tabId);
    },
    // A profile (re)connected: its extension may have lost what it drew.
    resend() {
      for (const c of claims.values()) {
        c.sent = undefined;
        c.fails = 0;
        c.retryAt = 0;
      }
    },
    close() {
      clearInterval(tickTimer);
    },
    // For `browserbear tabs`, so an agent can see a tab is another thread's.
    label(tabId) {
      const c = claims.get(tabId);
      const mark = c && c.sent && JSON.parse(c.sent);
      return mark ? ` [🐻 ${mark.name}: ${mark.state}]` : '';
    },
  };
}
