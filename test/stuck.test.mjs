// A tab that stops answering, in real headless Chrome, and a link that
// ignores real clicks. On BTC Markets (30 Oct) every command to one tab timed
// out after 20 s, over and over, with nothing to say why; and a real click on
// its "SELL BTC" link did nothing until it was sent again with --script.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { CHROME, headlessChrome, startBear } from './harness.mjs';

// Stand-in for a link whose handler ignores the real click: it only acts on
// a script one.
const PAGE = `<!doctype html><title>BTC</title><h1>BTC</h1><a href="#sell" id="sell">SELL BTC</a>
<script>
  sell.addEventListener('click', (e) => {
    e.preventDefault();
    if (!e.isTrusted) document.body.insertAdjacentHTML('beforeend', '<h2>Sell order</h2>');
  });
</script>`;

test('a stuck tab says why, and a link that ignores a real click gets a script one', { skip: !fs.existsSync(CHROME) && 'no Chrome' }, async (t) => {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(PAGE);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/`;

  const send = await headlessChrome(t);
  const { targetId } = await send('Target.createTarget', { url });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const page = (method, params) => send(method, params, sessionId);
  for (let i = 0; i < 50; i++) {
    const { result } = await page('Runtime.evaluate', { expression: 'document.readyState' });
    if (result.value === 'complete') break;
    await new Promise((r) => setTimeout(r, 100));
  }

  // A stuck debugger session: nothing comes back until the extension is
  // told to detach.
  let sessionStuck = false;
  const detaches = [];
  const { browserbear } = await startBear(
    t,
    async ({ op, args }) => {
      if (op === 'tabs') return [{ tabId: 1, url, title: 'BTC', active: true }];
      if (op === 'detach') {
        detaches.push(args.tabId);
        sessionStuck = false;
        return true;
      }
      if (op === 'cdp') return sessionStuck ? new Promise(() => {}) : page(args.method, args.params);
      throw new Error(`unexpected op ${op}`);
    },
    { BROWSERBEAR_CDP_WAIT_MS: '1500' },
  );

  const ref = (await browserbear('snap', '1')).match(/(e\d+) link "SELL BTC"/)[1];
  const clicked = await browserbear('click', '1', ref);
  assert.match(clicked, /real click on that link changed nothing, so it was clicked again by script/);
  assert.match(clicked, /Sell order/);

  // Stuck session, on a command that only looks: a fresh session, and the answer.
  sessionStuck = true;
  assert.match(await browserbear('snap', '1', '--full'), /SELL BTC/);
  assert.deepEqual(detaches, [1]);
  // ...and on one that might have done something: a fresh session, but not resent.
  sessionStuck = true;
  await assert.rejects(browserbear('eval', '1', 'document.title'), /debugger session was stuck, so BrowserBear started a fresh one; Runtime.evaluate may or may not have run/);
  assert.equal(await browserbear('eval', '1', 'document.title'), 'BTC');

  // A slow promise isn't a stuck page.
  await assert.rejects(browserbear('eval', '1', 'new Promise((r) => setTimeout(r, 3000))'), /the page still answers, so it's that command that's slow/);

  // The page's own main thread flat out: Chrome still answers, the page doesn't.
  await browserbear('eval', '1', 'setTimeout(() => { const until = Date.now() + 20000; while (Date.now() < until); }, 100); 1');
  await new Promise((r) => setTimeout(r, 300));
  await assert.rejects(browserbear('eval', '1', 'document.title'), /page isn't answering: Chrome is fine, but the page's own scripts are stuck/);
  // The next command says so after a quick look, not another full wait.
  const started = Date.now();
  await assert.rejects(browserbear('snap', '1'), new RegExp(`page isn't answering.*browserbear open ${url}`));
  assert.ok(Date.now() - started < 6000, `took ${Date.now() - started} ms`);
  assert.deepEqual(detaches, [1, 1]);
});
