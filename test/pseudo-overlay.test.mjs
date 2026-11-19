// A pseudo-element over what's clicked, as the Cloud console's billing dialog
// in AI Studio has (19 Nov): Material's dialog surface draws a ::before border
// over everything in it, pointer-events: none, and the hit test returned it
// (ignorePointerEventsNone: true hit-tests those too, unlike a real click).
// In a cross-origin frame the check for what's on top then passed it to a
// script as an argument, and Chrome refused it: "Argument should belong to the
// same JavaScript world as target object", so nothing in the dialog could be
// clicked. The real extension in Chrome for Testing, as frames need it.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { CFT, extensionInChrome, startBear } from './harness.mjs';

// The dialog, with the payments form in a frame of its own inside it, as
// payments.google.com is inside the console's: the border is in one document
// and what's clicked in another, in the same process.
const PAGE = `<!doctype html><title>Billing</title>
<style>
  .surface { position: relative; width: 340px; padding: 20px; }
  .surface::before { content: ''; position: absolute; inset: 0; border: 2px solid transparent; pointer-events: none; }
  .radio { position: relative; display: inline-block; padding: 8px; }
  .radio::before { content: ''; position: absolute; inset: 0; }
  .blocker { position: relative; }
  .blocker::after { content: ''; position: absolute; inset: 0; z-index: 1; }
  .stack { position: relative; }
  .stack::before { content: ''; position: absolute; inset: 0; z-index: 2; pointer-events: none; }
</style>
<div class="surface" role="dialog" aria-label="Buy credits">
  <div class="radio" role="radio" aria-checked="false" id="five">$5</div>
  <iframe src="/payments" style="width: 300px; height: 60px; border: 0"></iframe>
</div>
<div class="blocker" id="cover"><button id="under">Under</button></div>
<button id="labelled"><span style="pointer-events: none">Labelled</span></button>
<div class="stack"><button id="beneath">Beneath</button><div id="catcher" style="position: absolute; inset: 0; z-index: 1"></div></div>
<script>
window.log = [];
document.addEventListener('click', (e) => {
  const el = e.target.closest('[id]');
  if (el) log.push(el.id + (e.isTrusted ? '' : ' (untrusted)'));
});
</script>`;
const PAYMENTS = `<!doctype html><button id="pay">Pay now</button>
<script>document.addEventListener('click', (e) => parent.log.push(e.target.id + (e.isTrusted ? '' : ' (untrusted)')));</script>`;

test('a click lands through a pseudo-element drawn over it, in a cross-origin frame', { skip: !CFT && 'no Chrome for Testing' }, async (t) => {
  const frames = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(req.url === '/payments' ? PAYMENTS : PAGE);
  });
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><title>AI Studio</title><iframe src="http://localhost:${frames.address().port}/" style="width: 420px; height: 240px"></iframe>`);
  });
  for (const s of [server, frames]) {
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    t.after(() => s.close());
  }
  const url = `http://127.0.0.1:${server.address().port}/`;

  const inWorker = await extensionInChrome(t);
  const tabId = await inWorker(`chrome.tabs.create({ url: ${JSON.stringify(url)} }).then((t) => new Promise((r) => setTimeout(() => r(t.id), 2000)))`);
  const log = () =>
    inWorker(`ops.frames({ tabId: ${tabId} }).then((fs) => fs.find((f) => f.url.includes('localhost'))).then((f) => ops.cdp({ tabId: ${tabId}, sessionId: f.sessionId, method: 'Runtime.evaluate', params: { expression: 'JSON.stringify(log)', returnByValue: true } })).then((r) => JSON.parse(r.result.value))`);
  const { browserbear } = await startBear(t, async ({ op, args }) => {
    if (op === 'tabs') return [{ tabId, url, title: 'AI Studio', active: true }];
    if (op === 'cdp' || op === 'frames') return inWorker(`ops.${op}(${JSON.stringify(args)})`);
    throw new Error(`unexpected op ${op}`);
  });
  const TAB = String(tabId);
  const snap = await browserbear('snap', TAB);
  const ref = (name) => snap.match(new RegExp(`(e\\d+) \\w+ "${name.replace('$', '\\$')}"`))[1];

  // Under the dialog's see-through border, in the frame inside it: a real click.
  assert.doesNotMatch(await browserbear('click', TAB, ref('Pay now')), /script click/);
  // Under it too, with its own ::before as what's hit: a real click.
  assert.doesNotMatch(await browserbear('click', TAB, ref('$5')), /script click/);
  assert.deepEqual(await log(), ['pay', 'five']);

  // Another element's ::after that does take clicks: named, and a script click.
  assert.match(await browserbear('click', TAB, ref('Under')), /div#cover was on top of it, so that was a script click/);
  assert.equal((await log()).at(-1), 'under (untrusted)');
  // A label that takes no clicks: its button gets a real one.
  assert.doesNotMatch(await browserbear('click', TAB, '--css', '#labelled span'), /script click/);
  assert.equal((await log()).at(-1), 'labelled');
  // A see-through ::before over something that does take clicks: what's
  // under the pointer is that, not the ::before (Codex's review).
  assert.match(await browserbear('click', TAB, ref('Beneath')), /div#catcher was on top of it, so that was a script click/);
  assert.equal((await log()).at(-1), 'beneath (untrusted)');
});
