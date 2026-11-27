import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startBear } from './harness.mjs';
import { createMarks } from '../service/marks.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("an agent's tab carries its thread's name and state until the thread is done with it", async (t) => {
  // A fake tb: `list --json` prints whatever the test last wrote.
  const dir = fs.mkdtempSync(path.join('/tmp', 'bb-tb-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const listFile = path.join(dir, 'list.json');
  const tb = path.join(dir, 'tb');
  fs.writeFileSync(
    tb,
    `#!/bin/sh\ncase "$1" in\n  list) cat '${listFile}' ;;\n  status) echo 'Convex mirror: on to https://moose-1.ap-southeast-2.convex.cloud as M5' ;;\nesac\n`,
    { mode: 0o755 },
  );
  const thread = (fields) =>
    fs.writeFileSync(listFile, JSON.stringify([{ id: 'th-1', title: 'Poddle: fix the sleep timer on CarPlay', status: 'running', needs: 'nothing', ...fields }]));
  thread({});

  const marks = []; // what the service asked the extension to draw on tab 8
  const { browserbear } = await startBear(
    t,
    ({ op, args }) => {
      if (op === 'open') return { tabId: 8, url: 'https://example.com/', title: 'Example', active: true };
      if (op === 'tabs') return [{ tabId: 8, url: 'https://example.com/', title: 'Example', active: true, agent: true }];
      if (op === 'handoff') return { tabId: 8, url: 'https://example.com/', title: 'Example' };
      if (op === 'mark') return marks.push(args.mark), true;
      if (op === 'cdp') return args.method === 'Accessibility.getFullAXTree' ? { nodes: [] } : {};
      throw new Error(`unexpected op ${op}`);
    },
    { BROWSERBEAR_TB: tb, THREADBEAR_THREAD_ID: 'th-1', BROWSERBEAR_WORKING_MS: '1500', BROWSERBEAR_MARK_TICK_MS: '100' },
  );
  const latest = async (want) => {
    for (let i = 0; i < 50; i++) {
      const last = marks.at(-1);
      if (last !== undefined && want(last)) return last;
      await sleep(100);
    }
    assert.fail(`no matching mark; last was ${JSON.stringify(marks.at(-1))}`);
  };

  await browserbear('open', 'https://example.com', '--profile', 'Work');
  // Until tb answers it just says "agent"; then the thread's name, cut short.
  await latest((m) => m?.name !== 'agent');
  assert.deepEqual(
    marks.find((m) => m?.name !== 'agent'),
    { name: 'Poddle: fix the sleep t…', url: 'threadbear://thread/th-1', state: 'working', action: 'opening example.com', stop: true },
  );

  // Quiet for a moment while the thread carries on: grey, and other agents
  // see whose it is.
  assert.equal((await latest((m) => m?.state === 'idle')).action, 'thinking');
  assert.match(await browserbear('tabs'), /8\* Example <https:\/\/example\.com\/> \[🐻 Poddle: fix the sleep t…: idle\]/);

  // Handed to you: amber while the thread waits for you.
  await browserbear('handoff', '8');
  await latest((m) => m?.state === 'yours');
  thread({ status: 'idle', needs: 'you' });
  await sleep(1000);
  assert.equal(marks.at(-1)?.state, 'yours');

  // You answered, the thread finished without needing you: the marks come off.
  thread({ status: 'idle', needs: 'nothing' });
  await latest((m) => m === null);
  assert.doesNotMatch(await browserbear('tabs'), /🐻/);
});

test("createMarks coalesces in-flight sends and backs off when mark times out", async (t) => {
  const prevTb = process.env.BROWSERBEAR_TB;
  process.env.BROWSERBEAR_TB = "";
  t.after(() => {
    if (prevTb === undefined) delete process.env.BROWSERBEAR_TB;
    else process.env.BROWSERBEAR_TB = prevTb;
  });
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  let fail = true;
  let lastMark = null;
  const marks = createMarks({
    tickMs: 50,
    log: () => {},
    send: async (_tabId, mark) => {
      active++;
      maxActive = Math.max(maxActive, active);
      calls++;
      await sleep(80); // slower than tickMs so ticks would overlap without a guard
      active--;
      if (fail) throw new Error("mark timed out after 5s");
      lastMark = mark;
    },
  });
  t.after(() => marks.close());

  // Rapid overlapping updates must never run two sends concurrently for the same tab.
  marks.begin(7, null, "opening cubic.dev");
  marks.begin(7, null, "looking at the page");
  marks.end(7);
  marks.end(7);
  await sleep(450);

  assert.equal(maxActive, 1, "at most one mark RPC in flight per tab");
  // With 80ms sends and exponential backoff (50ms, 100ms, 200ms...), calls stay low.
  assert.ok(calls >= 2 && calls <= 4, `expected backed-off retries, got ${calls}`);

  // Once the tab recovers and resend() resets backoff, the mark lands cleanly.
  fail = false;
  marks.resend();
  await sleep(250);
  assert.equal(lastMark?.action, "looking at the page");
});

test("createMarks.stop(tabId) still interrupts the thread and does not kill periodic ticks", async (t) => {
  const dir = fs.mkdtempSync(path.join("/tmp", "bb-tb-stop-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logFile = path.join(dir, "calls.log");
  const tb = path.join(dir, "tb");
  fs.writeFileSync(
    tb,
    `#!/bin/sh\necho "$@" >> '${logFile}'\ncase "$1" in\n  list) echo '[{"id":"th-9","title":"Fix","status":"running","needs":"nothing"}]' ;;\n  status) echo "" ;;\nesac\n`,
    { mode: 0o755 },
  );
  const prevTb = process.env.BROWSERBEAR_TB;
  process.env.BROWSERBEAR_TB = tb;
  t.after(() => {
    if (prevTb === undefined) delete process.env.BROWSERBEAR_TB;
    else process.env.BROWSERBEAR_TB = prevTb;
  });

  const sent = [];
  const marks = createMarks({ tickMs: 50, log: () => {}, send: async (_tabId, m) => sent.push(m) });
  t.after(() => marks.close());

  marks.begin(9, "th-9", "working");
  await sleep(150);
  await marks.stop(9);
  const calls = fs.readFileSync(logFile, "utf8");
  assert.match(calls, /interrupt th-9/, "Stop button interrupts the thread");

  // Periodic ticks still work after stop(tabId) (i.e. stop() was not clobbered by cleanup).
  marks.end(9);
  marks.finished(9);
  await sleep(100);
  assert.ok(sent.some((m) => m?.thanks === true));
});

test("createMarks sends null before deleting a claim when the mark expires mid-send", async (t) => {
  const prevTb = process.env.BROWSERBEAR_TB;
  process.env.BROWSERBEAR_TB = "";
  t.after(() => {
    if (prevTb === undefined) delete process.env.BROWSERBEAR_TB;
    else process.env.BROWSERBEAR_TB = prevTb;
  });

  // Override THANKS_MS via a fresh dynamic import? Instead, simulate via thanks expiring:
  // THANKS_MS defaults to 3000ms unless BROWSERBEAR_THANKS_MS was set; here we test
  // the exact race by letting a send take longer than a short-lived claim or using thanks.
  // Actually test with a mark that becomes null during await send (thread archived/gone in tb list,
  // or using finished() + send lasting > THANKS_MS is 3.1s — fast enough for a real test!).
  const sent = [];
  let slowOnce = true;
  const marks = createMarks({
    tickMs: 50,
    log: () => {},
    send: async (_tabId, m) => {
      if (m?.thanks && slowOnce) {
        slowOnce = false;
        await sleep(3100); // thanks (3000ms) expires while this send is in flight
      }
      sent.push(m);
    },
  });
  t.after(() => marks.close());

  marks.begin(11, null, "working");
  marks.end(11);
  await sleep(80);
  marks.finished(11);
  await sleep(3400);

  assert.equal(sent.at(-1), null, "final null clear must be sent even when thanks expired mid-send");
});

test("createMarks.release guarantees null lands after an older delayed send", async (t) => {
  const prevTb = process.env.BROWSERBEAR_TB;
  process.env.BROWSERBEAR_TB = "";
  t.after(() => {
    if (prevTb === undefined) delete process.env.BROWSERBEAR_TB;
    else process.env.BROWSERBEAR_TB = prevTb;
  });

  const arrived = [];
  let releaseFirst;
  const firstDone = new Promise((r) => (releaseFirst = r));
  let firstCall = true;
  const marks = createMarks({
    tickMs: 50,
    log: () => {},
    send: async (_tabId, m) => {
      if (firstCall && m) {
        firstCall = false;
        await firstDone; // delayed in ownerOf() until after release() already sent its first null
      }
      arrived.push(m);
    },
  });
  t.after(() => marks.close());

  marks.begin(12, null, "working");
  await sleep(20);
  const rel = marks.release(12);
  await sleep(30);
  releaseFirst();
  await rel;

  assert.equal(arrived.at(-1), null, "final mark delivered after delayed send must be null");
});
