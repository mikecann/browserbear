// The real extension, loaded in Chrome for Testing (branded Chrome won't load
// unpacked extensions from the command line) next to test/nosy-extension, a
// stand-in for 1Password's inline menu. Its ops are called straight from its
// service worker, so this is chrome.debugger itself refusing the tab, as it
// did on passport.service.gov.uk (30 Oct). Skipped without Playwright's
// Chromium.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { root } from './harness.mjs';

const CACHE = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
const build = fs.existsSync(CACHE) && fs.readdirSync(CACHE).filter((d) => /^chromium-\d+$/.test(d)).sort().pop();
const CFT = build && path.join(CACHE, build, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
const BEAR_ID = 'iljcldkflmlnmfhbllafbbfnchhoccok'; // from the manifest's key

test("another extension's frame doesn't lock BrowserBear out of the tab", { skip: !(CFT && fs.existsSync(CFT)) && 'no Chrome for Testing' }, async (t) => {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<title>Address</title><input id="line1">');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/`;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'browserbear-cft-'));
  const exts = [path.join(root, 'extension'), path.join(root, 'test', 'nosy-extension')].join(',');
  const chrome = spawn(CFT, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', `--disable-extensions-except=${exts}`, `--load-extension=${exts}`, 'about:blank'], { stdio: 'ignore' });
  t.after(async () => {
    const gone = new Promise((r) => chrome.once('exit', r));
    chrome.kill();
    await gone;
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  });
  const portFile = path.join(profile, 'DevToolsActivePort');
  const read = () => (fs.existsSync(portFile) ? fs.readFileSync(portFile, 'utf8').split('\n') : []);
  // Chrome for Testing can take a while on its first start.
  for (let i = 0; i < 400 && !read()[1]; i++) await new Promise((r) => setTimeout(r, 100));
  const [port, wsPath] = read();
  const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  t.after(() => ws.close());
  let next = 1;
  const waiting = new Map();
  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    waiting.get(msg.id)?.(msg);
    waiting.delete(msg.id);
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve) => {
      const id = next++;
      waiting.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });

  let worker;
  for (let i = 0; i < 50 && !worker; i++) {
    const { result } = await send('Target.getTargets');
    worker = result.targetInfos.find((x) => x.type === 'service_worker' && x.url.includes(BEAR_ID));
    if (!worker) await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(worker, "BrowserBear's service worker never started");
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId: worker.targetId, flatten: true });
  // Runs in the worker; resolves to its value, rejects with its error.
  const inWorker = async (expression) => {
    const { result } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
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
