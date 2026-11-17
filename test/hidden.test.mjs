// BrowserBear's window covered by others, so Chrome stops drawing it and its
// pages go hidden: lazily drawn pages never fill in (YouTube Studio's
// analytics, 31 Oct). Agents' tabs get focus emulation, which makes Chrome
// draw them again; your own tabs are left alone. And a ref from a page the
// tab has left says so, not Chrome's "does not belong to the document".
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startBear, root } from './harness.mjs';

test("a hidden agent tab is woken before it's read; your own tabs aren't", async (t) => {
  const awake = new Set();
  const emulated = [];
  const { browserbear } = await startBear(t, ({ op, args }) => {
    if (op === 'tabs') {
      return [
        { tabId: 7, url: 'https://studio.example/', title: 'Studio', active: true, agent: true },
        { tabId: 8, url: 'https://chat.example/', title: 'Chat', active: true },
      ];
    }
    if (op === 'cdp') {
      const { tabId, method, params } = args;
      if (method === 'Emulation.setFocusEmulationEnabled') {
        // Your own tabs get it turned off before each look, in case it was left on.
        if (!params.enabled) return {};
        emulated.push(tabId);
        awake.add(tabId);
        return {};
      }
      if (method === 'Runtime.evaluate') {
        const e = params.expression;
        if (e.includes('visibilityState')) return { result: { value: awake.has(tabId) ? 'visible' : 'hidden' } };
        if (e.includes('readyState')) return { result: { value: 'complete' } };
        return { result: { value: awake.has(tabId) ? 'Reach report' : 'Video analytics' } };
      }
      if (method === 'Accessibility.getFullAXTree') return { nodes: [{ nodeId: '1', role: { value: 'button' }, name: { value: 'Go' }, backendDOMNodeId: 5 }] };
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelectorAll') return { nodeIds: [] };
      if (method === 'DOM.resolveNode') throw new Error('Node with given id does not belong to the document');
      return {};
    }
    return true;
  });

  assert.equal(await browserbear('read', '7'), 'Reach report');
  assert.equal(await browserbear('read', '8'), 'Video analytics');
  assert.deepEqual(emulated, [7]);
  // Already awake: not sent again.
  await browserbear('snap', '7');
  assert.deepEqual(emulated, [7]);

  await assert.rejects(browserbear('click', '7', 'e1', '--script'), /ref is from a page tab 7 has since left; snap 7 for fresh refs/);
});

// An eval loop polling YouTube Studio for a table, in an agent's tab behind
// another: Chrome throttled its timers and each page took a minute (17 Nov).
// eval and goto now wake an agent's tab first; one of the user's own is left
// hidden, with a note on stderr that keeps eval's stdout clean.
test('eval and goto wake a hidden agent tab first; a hidden user tab gets a note', async (t) => {
  const awake = new Set();
  const calls = [];
  let dragged = false;
  const { env } = await startBear(t, ({ op, args }) => {
    if (op === 'tabs') {
      return [
        { tabId: 7, url: 'https://studio.example/', title: 'Studio', active: false, agent: true, bear: true },
        { tabId: 8, url: 'https://chat.example/', title: 'Chat', active: false, agent: false, bear: false },
        // Opened by an agent, then dragged into one of the user's windows.
        { tabId: 9, url: 'https://mail.example/', title: 'Mail', active: false, agent: !dragged, bear: !dragged },
        { tabId: 10, url: 'https://news.example/', title: 'News', active: false, agent: false },
      ];
    }
    if (op === 'cdp') {
      const { tabId, method, params } = args;
      calls.push(`${tabId} ${method}`);
      if (method === 'Emulation.setFocusEmulationEnabled') {
        if (params.enabled) awake.add(tabId);
        else awake.delete(tabId);
        return {};
      }
      if (method === 'Runtime.evaluate') {
        const e = params.expression;
        if (e.includes('visibilityState')) return { result: { value: awake.has(tabId) ? 'visible' : 'hidden' } };
        if (e.includes('readyState')) return { result: { value: 'complete' } };
        return { result: { value: 42 } };
      }
      if (method === 'Page.getNavigationHistory') return { currentIndex: 0, entries: [{ url: 'https://studio.example/', title: 'Studio' }] };
      if (method === 'Accessibility.getFullAXTree') return { nodes: [] };
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelectorAll') return { nodeIds: [] };
      return {};
    }
    return true;
  });
  // Both streams, to see the note stays out of stdout.
  const run = (...a) => promisify(execFile)(process.execPath, [path.join(root, 'cli.mjs'), ...a], { env });

  const agent = await run('eval', '7', '6*7');
  assert.equal(agent.stdout.trim(), '42');
  assert.equal(agent.stderr, '');
  assert.ok(awake.has(7));

  // Left on by a service that has since restarted, and so forgot: off again.
  awake.add(8);
  const user = await run('eval', '8', '6*7');
  assert.equal(user.stdout.trim(), '42');
  assert.match(user.stderr, /tab 8 is hidden.*browserbear show 8/);
  assert.ok(!awake.has(8));

  // Woken as an agent's tab, then dragged out mid-loop: it's the user's now,
  // so the emulation comes off and it says it's hidden.
  await run('eval', '9', '1');
  assert.ok(awake.has(9));
  dragged = true;
  assert.match((await run('eval', '9', '6*7')).stderr, /tab 9 is hidden/);
  assert.ok(!awake.has(9));
  // ...and when the command is refused, or the tab is claimed, which go
  // round the usual path.
  for (const cmd of [['click', '9', 'e1'], ['claim', '9']]) {
    dragged = false;
    await run('eval', '9', '1');
    assert.ok(awake.has(9));
    dragged = true;
    await run(...cmd).catch(() => {});
    assert.ok(!awake.has(9), cmd.join(' '));
  }

  // An extension too old to say which window a tab is in, saying it isn't an
  // agent's: left alone.
  assert.match((await run('eval', '10', '6*7')).stderr, /tab 10 is hidden/);
  assert.ok(!awake.has(10));

  // goto wakes it before navigating, so the page loads unthrottled.
  awake.clear();
  calls.length = 0;
  await run('goto', '7', 'https://studio.example/next');
  const woke = calls.indexOf('7 Emulation.setFocusEmulationEnabled');
  assert.ok(woke >= 0 && woke < calls.indexOf('7 Page.navigate'), calls.join('\n'));
});
