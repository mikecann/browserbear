// BrowserBear's window covered by others, so Chrome stops drawing it and its
// pages go hidden: lazily drawn pages never fill in (YouTube Studio's
// analytics, 31 Oct). Agents' tabs get focus emulation, which makes Chrome
// draw them again; your own tabs are left alone. And a ref from a page the
// tab has left says so, not Chrome's "does not belong to the document".
import test from 'node:test';
import assert from 'node:assert/strict';
import { startBear } from './harness.mjs';

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
