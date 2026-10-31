// Pages that fail to load, and Chrome's warning pages, which it keeps debuggers
// out of (a host with the wrong certificate, vireo.de, 31 Oct). The first test
// is the service against a fake extension; the last is the real extension and
// a real certificate error.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { CFT, extensionInChrome, startBear } from './harness.mjs';

const CERT_ERROR = 'net::ERR_CERT_COMMON_NAME_INVALID';

test('a warning page is named, and goto gets the tab out', async (t) => {
  const bad = { tabId: 7, url: 'https://bad.example/', title: 'Privacy error', active: true, loadError: CERT_ERROR };
  const unexplained = { tabId: 8, url: 'https://chromewebstore.google.com/', title: 'Web Store', active: true };
  const good = { tabId: 7, url: 'https://good.example/', title: 'Good', active: true };
  let tab7 = bad;
  const navigated = [];
  const { browserbear } = await startBear(t, ({ op, args }) => {
    if (op === 'tabs') return [tab7, unexplained];
    if (op === 'open') return { ...bad, tabId: 9 };
    if (op === 'navigate') {
      navigated.push(args.url);
      tab7 = args.url.includes('bad') ? bad : good;
      return tab7;
    }
    if (op === 'cdp') {
      if (args.tabId !== 7 || tab7 === bad) throw new Error('Cannot attach to this target.');
      if (args.method === 'Runtime.evaluate') return { result: { value: args.params.expression.includes('readyState') ? 'complete' : 'Good text' } };
      if (args.method === 'Accessibility.getFullAXTree') return { nodes: [] };
      if (args.method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (args.method === 'DOM.querySelectorAll') return { nodeIds: [] };
      return {};
    }
    return true;
  });

  const started = Date.now();
  for (const cmd of [['read', '7'], ['snap', '7'], ['eval', '7', '1']]) {
    await assert.rejects(browserbear(...cmd), /certificate error on bad\.example \(net::ERR_CERT_COMMON_NAME_INVALID\).*can't get in.*goto 7/);
  }
  assert.ok(Date.now() - started < 5000, 'waited on a page that will never let it in');

  // Without a reason from the extension it still says what kind of thing this is.
  await assert.rejects(browserbear('read', '8'), /won't let BrowserBear into tab 8 \("Web Store".*Web Store.*goto 8/);

  // open has to give the id, or the tab is lost.
  await assert.rejects(browserbear('open', 'https://bad.example/', '--profile', 'Work'), /opened tab 9 in Work.*but: certificate error on bad\.example/);

  // goto to another bad page says so; goto to a good one recovers the tab.
  await assert.rejects(browserbear('goto', '7', 'https://bad.example/again'), /certificate error on bad\.example.*goto 7/);
  assert.match(await browserbear('goto', '7', 'https://good.example/'), /tab 7: Good <https:\/\/good\.example\/>/);
  assert.deepEqual(navigated, ['https://bad.example/again', 'https://good.example/']);
  assert.equal(await browserbear('read', '7'), 'Good text');
});

test('an older extension is told to reload rather than left stuck', async (t) => {
  const { browserbear } = await startBear(t, ({ op }) => {
    if (op === 'tabs') return [{ tabId: 7, url: 'https://bad.example/', title: 'Privacy error', active: true }];
    if (op === 'cdp') throw new Error('Cannot attach to this target.');
    throw new Error(`unknown op ${op}`);
  });
  await assert.rejects(browserbear('goto', '7', 'https://good.example/'), /older BrowserBear extension.*browserbear reload/);
});

test("goto to a host that doesn't resolve is an error even though the page can be read", async (t) => {
  const url = 'http://nope.invalid/';
  const { browserbear } = await startBear(t, ({ op, args }) => {
    if (op === 'tabs') return [{ tabId: 7, url, title: 'nope.invalid', active: true, loadError: 'net::ERR_NAME_NOT_RESOLVED' }];
    if (op === 'cdp') return args.method === 'Runtime.evaluate' ? { result: { value: args.params.expression.includes('readyState') ? 'complete' : 'This site can’t be reached' } } : {};
    return true;
  });
  await assert.rejects(browserbear('goto', '7', url), /nope\.invalid didn't load \(net::ERR_NAME_NOT_RESOLVED\).*goto 7/);
  assert.match(await browserbear('read', '7'), /can’t be reached/);
});

test("profiles still work by email when Chrome's list can't be read", async (t) => {
  const { browserbear, profiles } = await startBear(t, ({ op }) => (op === 'tabs' ? [] : true), { BROWSERBEAR_CHROME_LOCAL_STATE: '/nonexistent/Local State' });
  assert.match(profiles, /● me@example\.com/);
  assert.match(profiles, /can't read Chrome's list of profiles/);
  assert.match(await browserbear('tabs', '--profile', 'me@example.com'), /me@example\.com:/);
  await assert.rejects(browserbear('tabs', '--profile', 'Default'), /no connected profile matches "Default"; connected: me@example\.com\. .*can't read Chrome's list.*use the email/);
});

test('a profile is found by its folder when the list can be read', async (t) => {
  const { browserbear } = await startBear(t, ({ op }) => (op === 'tabs' ? [] : true));
  assert.match(await browserbear('tabs', '--profile', 'Profile 2'), /Work \(me@example\.com\):/);
  await assert.rejects(browserbear('tabs', '--profile', 'Default'), (e) => /no connected profile matches "Default"; connected: Work/.test(e.message) && !/can't read/.test(e.message));
});

test('the real extension reports a certificate error and navigates away from it', { skip: !CFT && 'no Chrome for Testing' }, async (t) => {
  // Self-signed, so Chrome stops at its warning page.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browserbear-cert-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const [key, cert] = [path.join(dir, 'key.pem'), path.join(dir, 'cert.pem')];
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=browserbear.test'], { stdio: 'ignore' });
  const handler = (req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<title>Fine</title><p>Fine</p>');
  };
  const secure = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, handler);
  const plain = http.createServer(handler);
  await Promise.all([secure, plain].map((s) => new Promise((r) => s.listen(0, '127.0.0.1', r))));
  t.after(() => {
    secure.close();
    plain.close();
  });
  const badUrl = `https://127.0.0.1:${secure.address().port}/`;
  const goodUrl = `http://127.0.0.1:${plain.address().port}/`;

  const inWorker = await extensionInChrome(t);
  const opened = await inWorker(`ops.open({ url: ${JSON.stringify(badUrl)} })`);
  assert.match(opened.loadError, /^net::ERR_CERT_/);
  const title = (tabId) => inWorker(`ops.cdp({ tabId: ${tabId}, method: 'Runtime.evaluate', params: { expression: 'document.title', returnByValue: true } }).then((r) => r.result.value)`);
  await assert.rejects(title(opened.tabId), /Cannot attach to this target/);

  const moved = await inWorker(`ops.navigate({ tabId: ${opened.tabId}, url: ${JSON.stringify(goodUrl)} })`);
  assert.equal(moved.url, goodUrl);
  assert.equal(moved.loadError, undefined);
  assert.equal(await title(opened.tabId), 'Fine');

  // Going back to it while the debugger is attached ends up the same way.
  const back = await inWorker(`ops.navigate({ tabId: ${opened.tabId}, url: ${JSON.stringify(badUrl)} })`);
  assert.match(back.loadError, /^net::ERR_CERT_/);
  await assert.rejects(title(opened.tabId), /Cannot attach to this target/);

  // A dead host: nothing listens here any more.
  const dead = await inWorker(`ops.open({ url: 'http://127.0.0.1:9/' })`);
  assert.match(dead.loadError, /^net::ERR_/);
});
