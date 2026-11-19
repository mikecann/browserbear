// A click whose effect comes after the settle, in real headless Chrome. On
// Google's sign-in popup for claude.ai (5 Nov) click said "(no change)" and
// suggested --script, but it had worked: the popup closed itself a moment later,
// and the --script retry then failed with "No tab with given id".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { CHROME, headlessChrome, startBear } from './harness.mjs';

const PAGE = `<!doctype html><title>Popup</title><h1>Sign in</h1>
<button id="closes" onclick="setTimeout(() => fetch('/close'), 1500)">Closes later</button>
<button id="closesNow" onclick="fetch('/close')">Closes now</button>
<button id="moves" onclick="setTimeout(() => { location.href = '/next'; }, 1500)">Moves later</button>
<button id="quiet" onclick="setTimeout(() => history.pushState({}, '', '/step2'), 1500)">Moves quietly</button>
<button id="draws" onclick="setTimeout(() => { document.body.insertAdjacentHTML('beforeend', '<h2>Saved</h2>'); }, 1500)">Draws later</button>
<button id="nothing">Does nothing</button>
<input aria-label="Name">`;

test('a click that closes or moves its tab later is not reported as doing nothing', { skip: !fs.existsSync(CHROME) && 'no Chrome' }, async (t) => {
  const send = await headlessChrome(t);
  let current = null; // this tab's page; null once closed
  let closeOn = null; // a CDP method the tab goes away on
  const server = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'text/html');
    if (req.url === '/close') {
      // window.close() only works on a window a script opened, which a test's isn't.
      await send('Target.closeTarget', { targetId: current.targetId });
      current = null;
    }
    res.end(req.url === '/next' ? '<!doctype html><title>Next</title><h1>Next page</h1>' : PAGE);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/`;

  const openPage = async () => {
    const { targetId } = await send('Target.createTarget', { url });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    current = { targetId, sessionId };
    for (let i = 0; i < 50; i++) {
      const { result } = await send('Runtime.evaluate', { expression: 'document.readyState' }, sessionId);
      if (result.value === 'complete') break;
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  const { browserbear } = await startBear(t, async ({ op, args }) => {
    if (op === 'tabs') {
      if (!current) return [];
      const { result } = await send('Runtime.evaluate', { expression: '[location.href, document.title]', returnByValue: true }, current.sessionId).catch(() => ({ result: { value: [url, ''] } }));
      return [{ tabId: 1, url: result.value[0], title: result.value[1], active: true }];
    }
    if (op === 'cdp') {
      // As the extension says it when it tries to attach to a tab that has gone.
      if (!current) throw new Error('No tab with given id 1.');
      if (args.method === closeOn) {
        closeOn = null;
        await send('Target.closeTarget', { targetId: current.targetId });
        current = null;
        throw new Error('No tab with given id 1.');
      }
      return send(args.method, args.params, current.sessionId);
    }
    throw new Error(`unexpected op ${op}`);
  });
  const clickAfterSnap = async (name, ...flags) => {
    const snap = await browserbear('snap', '1', '--full');
    return browserbear('click', '1', snap.match(new RegExp(`(e\\d+) \\w+ "${name}"`))[1], ...flags);
  };

  // Moves on a moment later: shows the next page, with no --script suggestion.
  await openPage();
  const moved = await clickAfterSnap('Moves later');
  assert.match(moved, /Next page/);
  assert.doesNotMatch(moved, /--script|no change/);

  // Only the address changes, a moment later: that's not "nothing".
  await openPage();
  const quiet = await clickAfterSnap('Moves quietly');
  assert.match(quiet, /step2/);
  assert.doesNotMatch(quiet, /--script/);

  // Draws something a moment later.
  await openPage();
  const drawn = await clickAfterSnap('Draws later');
  assert.match(drawn, /Saved/);
  assert.doesNotMatch(drawn, /--script/);

  // Really does nothing: still says so, and how to try harder.
  await openPage();
  const nothing = await clickAfterSnap('Does nothing');
  assert.match(nothing, /if that click should have done something: .*--script/);
  assert.doesNotMatch(nothing, /closed straight/);

  // A field clicked for focus doesn't wait around to see if it does more.
  const started = Date.now();
  await clickAfterSnap('Name');
  assert.ok(Date.now() - started < 2500, `took ${Date.now() - started} ms`);

  // Closes itself a moment later: says that, not "(no change)".
  const snapped = await browserbear('snap', '1', '--full');
  const ref = snapped.match(/(e\d+) button "Closes later"/)[1];
  const closed = await browserbear('click', '1', ref);
  assert.match(closed, /closed straight after that/);
  assert.doesNotMatch(closed, /--script|no change/);

  // The retry that hit this says the tab has gone, in words, and doesn't claim to have worked.
  await assert.rejects(browserbear('click', '1', ref, '--script'), /tab 1 has closed, or isn't in any connected profile/);

  // Closes as the click lands.
  await openPage();
  const closedNow = await clickAfterSnap('Closes now');
  assert.match(closedNow, /closed straight after that/);

  // Goes while the click is still working out where to land: nothing was clicked,
  // so that's an error and not "closed straight after that".
  await openPage();
  const snap3 = await browserbear('snap', '1', '--full');
  closeOn = 'DOM.getContentQuads';
  await assert.rejects(browserbear('click', '1', snap3.match(/(e\d+) button "Does nothing"/)[1]), /tab 1 has closed/);

  // A tab that went without BrowserBear seeing it: the first command after says so.
  await openPage();
  const snap2 = await browserbear('snap', '1', '--full');
  const ref2 = snap2.match(/(e\d+) button "Does nothing"/)[1];
  await send('Target.closeTarget', { targetId: current.targetId });
  current = null;
  await assert.rejects(browserbear('click', '1', ref2), /tab 1 has closed/);
  await assert.rejects(browserbear('read', '1'), /tab 1 has closed/);
});
