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
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Env vars so tests needn't wait.
const WORKING_MS = Number(process.env.BROWSERBEAR_WORKING_MS) || 12_000;
const TICK_MS = Number(process.env.BROWSERBEAR_MARK_TICK_MS) || 4_000;
const LONE_MS = 120_000;

function tbPath() {
  if ('BROWSERBEAR_TB' in process.env) return process.env.BROWSERBEAR_TB || null;
  const current = path.join(os.homedir(), 'Library', 'Application Support', 'Threadbear', 'runner', 'current', 'bin', 'tb');
  return fs.existsSync(current) ? current : null;
}

// Threadbear's tb starts with `#!/usr/bin/env node`, and Chrome starts this
// service with no node on its PATH, so it runs on this service's own Node.
// (A shell script, like the tests' fake, runs as itself.)
const run = (file, args) =>
  new Promise((resolve) => {
    const node = fs.readFileSync(file, 'utf8').startsWith('#!/usr/bin/env node');
    const [cmd, argv] = node ? [process.execPath, [file, ...args]] : [file, args];
    execFile(cmd, argv, { timeout: 15_000 }, (e, out) => resolve(e ? null : out));
  });

// Short enough to leave room for the page's own title; no "·", which
// separates the name from the title.
const shortName = (title) => {
  const t = title.replace(/·/g, '-').trim();
  return t.length > 24 ? `${t.slice(0, 23).trimEnd()}…` : t;
};

// send(tabId, mark | null) draws or clears a tab's marks; it rejects with
// "No tab with id" once the tab is gone.
export function createMarks({ send, log }) {
  const claims = new Map(); // tabId -> { thread, action, at, busy, yours, sent }
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
    const mark = markFor(c);
    const key = JSON.stringify(mark);
    if (key !== c.sent) {
      try {
        await send(tabId, mark);
        c.sent = key;
      } catch (e) {
        if (/no tab/i.test(e.message)) claims.delete(tabId);
        else log('mark failed', tabId, e.message); // an older extension, or a page that won't take scripts
        return;
      }
    }
    if (!mark && claims.get(tabId) === c && !c.busy) claims.delete(tabId);
  }

  setInterval(async () => {
    if (!claims.size) return;
    await refreshThreads();
    for (const tabId of [...claims.keys()]) await push(tabId);
  }, TICK_MS).unref();

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
    // A command on the tab is starting (begin) or has finished (end).
    begin(tabId, thread, action) {
      const c = claim(tabId, thread);
      Object.assign(c, { busy: c.busy + 1, at: Date.now(), action, yours: false });
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
      Object.assign(claim(tabId, thread), { yours: true, at: Date.now() });
      soon(tabId);
    },
    closed(tabId) {
      claims.delete(tabId);
    },
    // From the pill's buttons.
    async release(tabId) {
      claims.delete(tabId);
      await send(tabId, null).catch(() => {});
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
      for (const c of claims.values()) c.sent = undefined;
    },
    // For `browserbear tabs`, so an agent can see a tab is another thread's.
    label(tabId) {
      const c = claims.get(tabId);
      const mark = c && c.sent && JSON.parse(c.sent);
      return mark ? ` [🐻 ${mark.name}: ${mark.state}]` : '';
    },
  };
}
