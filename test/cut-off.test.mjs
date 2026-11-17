// Chrome cutting the debugger off as it attaches (canceled_by_user), which it
// does to every BrowserBear session while one of its windows can't show the
// "started debugging this browser" bar: another profile's window opening did
// it for a minute (Zoho, 17 Nov 2026). The extension then answers "Debugger is
// not attached" until the bar stays.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startBear } from './harness.mjs';

const tab = { tabId: 9, url: 'https://campaigns.example/', title: 'Campaigns', active: true };

function fakePage(cutOffFor) {
  let until = null;
  let bear;
  const onOp = ({ op, args }) => {
    if (op === 'tabs') return [tab];
    if (op === 'open') {
      until = Date.now() + cutOffFor;
      return tab;
    }
    if (op === 'cdp' || op === 'frames') {
      if (until === null) until = Date.now() + cutOffFor;
      if (Date.now() < until) {
        bear.fromExtension({ type: 'event', event: 'detached', tabId: 9, reason: 'canceled_by_user' });
        throw new Error('Debugger is not attached to the tab with id: 9.');
      }
      if (op === 'frames') return [];
      if (args.method === 'Runtime.evaluate') {
        const x = args.params.expression;
        return { result: { value: x.includes('readyState') ? 'complete' : x.includes('visibilityState') ? 'visible' : x.includes('innerText') ? 'Campaign text' : true } };
      }
      if (args.method === 'Accessibility.getFullAXTree') return { nodes: [] };
      if (args.method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (args.method === 'DOM.querySelectorAll') return { nodeIds: [] };
      return {};
    }
    return true;
  };
  return { onOp, set: (b) => (bear = b) };
}

test('open and read wait out a short cut-off instead of failing', async (t) => {
  const page = fakePage(2_000);
  const bear = await startBear(t, page.onOp);
  page.set(bear);
  assert.equal(await bear.browserbear('open', 'https://campaigns.example/', '--profile', 'Work', '--id'), '9');
});

test("snap doesn't take a cut-off as a page with no frames", async (t) => {
  const page = fakePage(60_000);
  const bear = await startBear(t, page.onOp, { BROWSERBEAR_CUT_OFF_WAIT_MS: '1000' });
  page.set(bear);
  await assert.rejects(bear.browserbear('snap', '9'), /kept cutting BrowserBear's debugger off from tab 9/);
});

test('a cut-off that lasts is named, and open --id still prints only the id', async (t) => {
  const page = fakePage(60_000);
  const bear = await startBear(t, page.onOp, { BROWSERBEAR_CUT_OFF_WAIT_MS: '3000' });
  page.set(bear);
  const started = Date.now();
  const e = await bear.browserbear('open', 'https://campaigns.example/', '--profile', 'Work', '--id').then(() => null, (err) => err);
  assert.ok(e, 'open should fail');
  assert.equal(e.stdout, '9\n');
  assert.match(e.stderr, /opened tab 9 in Work.*couldn't look at it yet: Chrome kept cutting BrowserBear's debugger off from tab 9.*canceled_by_user/);
  // One wait, not one for each look open makes.
  assert.ok(Date.now() - started < 8_000, `took ${Date.now() - started} ms`);
  // Straight after giving up, the next command doesn't wait it all out again.
  const again = Date.now();
  await assert.rejects(bear.browserbear('read', '9'), /kept cutting BrowserBear's debugger off from tab 9/);
  assert.ok(Date.now() - again < 1_400, `read took ${Date.now() - again} ms`);
});
