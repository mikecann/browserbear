import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startBear } from './harness.mjs';

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
