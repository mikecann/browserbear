// The real extension, loaded in Chrome for Testing (branded Chrome won't load
// unpacked extensions from the command line) next to test/nosy-extension, a
// stand-in for 1Password's inline menu. Its ops are called straight from its
// service worker, so this is chrome.debugger itself refusing the tab, as it
// did on passport.service.gov.uk (30 Oct). Skipped without Playwright's
// Chromium.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { CFT, extensionInChrome, root } from './harness.mjs';

test("another extension's frame doesn't lock BrowserBear out of the tab", { skip: !CFT && 'no Chrome for Testing' }, async (t) => {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<title>Address</title><input id="line1">');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/`;

  const inWorker = await extensionInChrome(t, [path.join(root, 'test', 'nosy-extension')]);
  const openTab = (u) => inWorker(`chrome.tabs.create({ url: ${JSON.stringify(u)} }).then((t) => new Promise((r) => setTimeout(() => r(t.id), 2000)))`);
  const cdp = (tabId, expression) =>
    inWorker(`ops.cdp({ tabId: ${tabId}, method: 'Runtime.evaluate', params: { expression: ${JSON.stringify(expression)}, returnByValue: true } }).then((r) => r.result.value)`);

  // The menu turns up while BrowserBear is attached: Chrome cuts it off.
  // Whichever command that lands on, the tab works again straight after.
  const tab = await openTab(url);
  assert.equal(await cdp(tab, 'document.title'), 'Address');
  await cdp(tab, "document.querySelector('#line1').focus()").catch((e) => assert.match(e.message, /another extension's frame .* snap to see/));
  await new Promise((r) => setTimeout(r, 1000));
  const fill = () => cdp(tab, "document.querySelector('#line1').value = '35 Keel Retreat'");
  await fill().catch((e) => {
    assert.match(e.message, /another extension's frame/);
    return fill();
  });
  assert.equal(await cdp(tab, "document.querySelector('#line1').value"), '35 Keel Retreat');

  // The menu is already up before BrowserBear first attaches: refused, then let in.
  const tab2 = await openTab(`${url}?now`);
  assert.equal(await cdp(tab2, 'document.title'), 'Address');
});
