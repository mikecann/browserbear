// A real click on a form button whose next page is slow to arrive, in real
// headless Chrome: click should show the next page, not "(no change)", and
// read straight after should wait for it rather than throw (GOV.UK, 30 Oct).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { CHROME, headlessChrome, startBear } from './harness.mjs';

const FORM = `<!doctype html><title>Step 1</title><h1>Step 1</h1>
<form method="post" action="/next"><button type="submit">Continue</button></form>`;
const NEXT = `<!doctype html><title>Step 2</title><h1>Step 2</h1><p>Your photo</p>`;
// Arrives in two parts, so for a second the page is there with no body yet.
const SLOW_HEAD = `<!doctype html><html><head><title>Step 3</title>`;
const SLOW_REST = `</head><body><h1>Step 3</h1><p>Check your answers</p></body></html>`;

test('click and read wait for the page a form submit goes to', { skip: !fs.existsSync(CHROME) && 'no Chrome' }, async (t) => {
  // The next page takes 1.5 s, well past the settle after a click.
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    if (req.url === '/next') setTimeout(() => res.end(NEXT), 1500);
    else if (req.url === '/slow') {
      res.write(SLOW_HEAD);
      setTimeout(() => res.end(SLOW_REST), 1000);
    }
    else res.end(FORM);
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

  const { browserbear } = await startBear(t, async ({ op, args }) => {
    if (op === 'tabs') {
      const { result } = await page('Runtime.evaluate', { expression: '[location.href, document.title]', returnByValue: true }).catch(() => ({ result: { value: [url, ''] } }));
      return [{ tabId: 1, url: result.value[0], title: result.value[1], active: true }];
    }
    if (op === 'cdp') return page(args.method, args.params);
    throw new Error(`unexpected op ${op}`);
  });

  const snap = await browserbear('snap', '1');
  const ref = snap.match(/(e\d+) button "Continue"/)[1];
  const out = await browserbear('click', '1', ref);
  assert.doesNotMatch(out, /no change/);
  assert.match(out, /Step 2/);
  assert.match(await browserbear('read', '1'), /Your photo/);

  // read while the next page has arrived but its body hasn't.
  await page('Page.navigate', { url: `${url}slow` });
  const { result } = await page('Runtime.evaluate', { expression: 'document.body === null' });
  assert.equal(result.value, true);
  assert.match(await browserbear('read', '1'), /Check your answers/);
});
