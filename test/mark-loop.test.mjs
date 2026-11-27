// A reactive SPA (cubic.dev, 27 Nov 2026) reconciling <title> and <link rel="icon">
// fought drawMark's MutationObserver in a tight microtask loop, growing m.saved
// unboundedly and flooding Chrome's browser process with title/favicon IPCs until
// PartitionAlloc OOM'd. Verify drawMark pauses its observer around its own edits,
// bounds m.saved, yields any channel a page keeps reverting (keeping the pill/glow),
// and still keeps normal dynamic sites (like Gmail) prefixed and badged.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { CFT, extensionInChrome } from './harness.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(50);
  }
  return fn();
};

// 1x1 transparent PNG so /fav.png loads cleanly in badgedIcon().
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

test('drawMark breaks reactive <head> fight loops while keeping normal dynamic sites marked', { skip: !CFT && 'needs Chrome for Testing' }, async (t) => {
  const pages = {
    // Reproduces a reactive SPA fighting both <title> and <link rel="icon"> on every mutation.
    // Safety cap (200) keeps an unpatched extension from OOM'ing the test runner.
    '/fight-both': `<!doctype html><html><head>
      <title>Billing | Cubic</title>
      <link id="ico" rel="icon" href="/fav.png">
      <script>
        window.__titleFights = 0;
        window.__iconFights = 0;
        const CAP = 200;
        new MutationObserver(() => {
          if (window.__titleFights < CAP && document.title !== 'Billing | Cubic') {
            window.__titleFights++;
            document.title = 'Billing | Cubic';
          }
          const ico = document.getElementById('ico');
          const bb = document.querySelectorAll('link[data-browserbear]');
          if (window.__iconFights < CAP && ((ico && ico.rel !== 'icon') || bb.length)) {
            window.__iconFights++;
            if (ico) ico.rel = 'icon';
            bb.forEach((el) => el.remove());
          }
        }).observe(document.head, { childList: true, subtree: true, characterData: true, attributes: true });
      </script>
    </head><body><h1>Billing</h1></body></html>`,

    // Reproduces a page fighting ONLY <link rel="icon"> by replacing the <link> node every time.
    '/fight-icon': `<!doctype html><html><head>
      <title>Settings</title>
      <link class="site-ico" rel="icon" href="/fav.png">
      <script>
        window.__iconFights = 0;
        const CAP = 200;
        new MutationObserver(() => {
          const hidden = document.querySelectorAll('link[rel="browserbear-icon"]');
          const bb = document.querySelectorAll('link[data-browserbear]');
          if (window.__iconFights < CAP && (hidden.length || bb.length)) {
            window.__iconFights++;
            hidden.forEach((el) => el.remove());
            bb.forEach((el) => el.remove());
            const fresh = document.createElement('link');
            fresh.className = 'site-ico';
            fresh.rel = 'icon';
            fresh.href = '/fav.png?v=' + window.__iconFights;
            document.head.append(fresh);
          }
        }).observe(document.head, { childList: true, subtree: true, attributes: true });
      </script>
    </head><body><h1>Settings</h1></body></html>`,

    // Slow favicon server to test release winning over an in-flight paint.
    '/slow-fav': `<!doctype html><html><head>
      <title>Slow Icon</title>
      <link rel="icon" href="/slow.png">
    </head><body><h1>Slow</h1></body></html>`,

    // A normal dynamic site like Gmail that updates its unread title and swaps its icon once.
    '/gmail': `<!doctype html><html><head>
      <title>Inbox</title>
      <link id="ico" rel="shortcut icon" href="/fav.png">
    </head><body><h1>Inbox</h1></body></html>`,
  };

  const server = http.createServer((req, res) => {
    const pathOnly = req.url.split('?')[0];
    if (pathOnly === '/fav.png') return res.writeHead(200, { 'content-type': 'image/png' }).end(PNG);
    if (pathOnly === '/slow.png') return setTimeout(() => res.writeHead(200, { 'content-type': 'image/png' }).end(PNG), 600);
    res.writeHead(200, { 'content-type': 'text/html' }).end(pages[pathOnly] || '');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const inWorker = await extensionInChrome(t);
  const open = (p) => inWorker(`ops.open({ url: '${base}${p}' }).then((t) => t.tabId)`);
  const inPage = (tabId, fn, world = 'ISOLATED') =>
    inWorker(`chrome.scripting.executeScript({ target: { tabId: ${tabId} }, world: '${world}', func: ${fn} }).then(([r]) => r.result)`);
  const setMark = (tabId, mark) => inWorker(`ops.mark({ tabId: ${tabId}, mark: ${JSON.stringify(mark)} })`);

  // 1. Reactive page fighting both <title> and <link rel="icon">.
  const both = await open('/fight-both');
  await setMark(both, { name: 'agent', url: null, state: 'working', action: 'opening cubic.dev', stop: false });

  await until(() => inPage(both, () => !!(window.__browserbearMark?.titleYielded && window.__browserbearMark?.iconYielded)));
  const snap1 = await inPage(both, () => ({
    title: document.title,
    icoRel: document.getElementById('ico')?.rel,
    bbLinks: document.querySelectorAll('link[data-browserbear]').length,
    savedSize: window.__browserbearMark?.saved instanceof Map ? window.__browserbearMark.saved.size : window.__browserbearMark?.saved?.length,
    titleYielded: !!window.__browserbearMark?.titleYielded,
    iconYielded: !!window.__browserbearMark?.iconYielded,
    hostConnected: !!window.__browserbearMark?.host?.isConnected,
    pillText: window.__browserbearMark?.parts?.text?.textContent,
  }));
  const counts1 = await inPage(both, () => ({ title: window.__titleFights, icon: window.__iconFights }), 'MAIN');

  assert.equal(snap1.titleYielded, true, 'title channel yielded');
  assert.equal(snap1.iconYielded, true, 'icon channel yielded');
  assert.ok(counts1.title > 0 && counts1.title <= 6, `bounded title fights, got ${counts1.title}`);
  assert.ok(counts1.icon > 0 && counts1.icon <= 6, `bounded icon fights, got ${counts1.icon}`);
  assert.equal(snap1.savedSize, 0, 'saved map bounded and cleared after yielding');
  assert.equal(snap1.title, 'Billing | Cubic', 'page title left intact');
  assert.equal(snap1.icoRel, 'icon', 'page favicon restored');
  assert.equal(snap1.bbLinks, 0, 'browserbear icon link removed after yielding');
  assert.equal(snap1.hostConnected, true, 'floating pill and glow remain intact');
  assert.equal(snap1.pillText, '🐻 agent · opening cubic.dev');

  // Quiet after yielding, and stays yielded across subsequent mark updates.
  await sleep(350);
  await setMark(both, { name: 'agent', url: null, state: 'idle', action: 'thinking', stop: false });
  await sleep(350);
  const counts2 = await inPage(both, () => ({ title: window.__titleFights, icon: window.__iconFights }), 'MAIN');
  assert.deepEqual(counts2, counts1, 'no further title/icon fights after yielding or on mark update');
  assert.equal(await inPage(both, () => window.__browserbearMark?.parts?.text?.textContent), '🐻 agent · thinking');

  // Clearing the mark removes the pill and leaves the page's title intact.
  await setMark(both, null);
  assert.deepEqual(await inPage(both, () => ({ mark: window.__browserbearMark ?? null, title: document.title, host: document.querySelector('browserbear-mark') })), {
    mark: null,
    title: 'Billing | Cubic',
    host: null,
  });

  // 2. Reactive page fighting ONLY <link rel="icon"> by replacing <link> nodes:
  // icon yields and saved stays bounded, while title prefix and pill stay active.
  const iconOnly = await open('/fight-icon');
  await setMark(iconOnly, { name: 'Brief', url: null, state: 'working', action: 'checking', stop: false });
  await until(() => inPage(iconOnly, () => !!window.__browserbearMark?.iconYielded));
  const iconSnap = await inPage(iconOnly, () => ({
    title: document.title,
    titleYielded: !!window.__browserbearMark?.titleYielded,
    iconYielded: !!window.__browserbearMark?.iconYielded,
    savedSize: window.__browserbearMark?.saved instanceof Map ? window.__browserbearMark.saved.size : window.__browserbearMark?.saved?.length,
    hostConnected: !!window.__browserbearMark?.host?.isConnected,
    siteIcons: document.querySelectorAll('link[rel="icon"]:not([data-browserbear])').length,
    bbLinks: document.querySelectorAll('link[data-browserbear]').length,
  }));
  const iconFights = await inPage(iconOnly, () => window.__iconFights, 'MAIN');
  assert.equal(iconSnap.iconYielded, true);
  assert.equal(iconSnap.titleYielded, false, 'title stays active when only icon fights');
  assert.equal(iconSnap.title, '🐻 Brief · Settings');
  assert.equal(iconSnap.savedSize, 0);
  assert.equal(iconSnap.hostConnected, true);
  assert.ok(iconSnap.siteIcons >= 1 && iconSnap.bbLinks === 0);
  assert.ok(iconFights > 0 && iconFights <= 6, `bounded icon fights, got ${iconFights}`);

  // 3. Normal dynamic site (Gmail): title updates and an icon swap stay marked,
  // unrelated <head> churn doesn't trip the breaker, and clearing restores the latest state.
  const gmail = await open('/gmail');
  await setMark(gmail, { name: 'Mail', url: null, state: 'working', action: 'reading', stop: false });
  assert.equal(await inPage(gmail, () => document.title), '🐻 Mail · Inbox');
  assert.equal(await inPage(gmail, () => window.__browserbearMark?.saved?.size), 1);

  await inPage(gmail, () => { document.title = '(1) Inbox'; }, 'MAIN');
  assert.ok(await until(() => inPage(gmail, () => document.title === '🐻 Mail · (1) Inbox')));

  await inPage(gmail, () => {
    document.title = '(2) Inbox';
    // Unrelated <head> churn (e.g. CSS-in-JS styles) must not trip any breaker.
    for (let i = 0; i < 15; i++) {
      const s = document.createElement('style');
      s.textContent = `.c${i}{color:red}`;
      document.head.append(s);
    }
    // Swap favicon once (removes old link, adds new one).
    document.getElementById('ico')?.remove();
    const next = document.createElement('link');
    next.id = 'ico2';
    next.rel = 'icon';
    next.href = '/fav.png?unread=2';
    document.head.append(next);
  }, 'MAIN');
  assert.ok(await until(() => inPage(gmail, () => document.title === '🐻 Mail · (2) Inbox' && document.getElementById('ico2')?.rel === 'browserbear-icon')));

  const gmailState = await inPage(gmail, () => ({
    titleYielded: !!window.__browserbearMark?.titleYielded,
    iconYielded: !!window.__browserbearMark?.iconYielded,
    savedSize: window.__browserbearMark?.saved?.size,
    bbLinks: document.querySelectorAll('link[data-browserbear]').length,
  }));
  assert.deepEqual(gmailState, { titleYielded: false, iconYielded: false, savedSize: 1, bbLinks: 1 });

  // Mutating the active <link rel="icon"> href directly (which selects BrowserBear's link)
  // still restores our badged icon cleanly without looping.
  await inPage(gmail, () => {
    const active = document.querySelector('link[rel="icon"]');
    if (active) active.href = '/fav.png?mutated=1';
  }, 'MAIN');
  assert.ok(await until(() => inPage(gmail, () => document.querySelector('link[data-browserbear]')?.getAttribute('href')?.startsWith('data:image/png'))));

  await setMark(gmail, null);
  // 4. Releasing a tab while an earlier paint is awaiting a slow favicon fetch must not resurrect the mark.
  const slow = await open('/slow-fav');
  await inWorker(`(async () => {
    const first = ops.mark({ tabId: ${slow}, mark: { name: 'Slow', url: null, state: 'working', action: 'loading', stop: false } });
    await new Promise((r) => setTimeout(r, 80));
    await ops.mark({ tabId: ${slow}, mark: null });
    await first;
  })()`);
  await sleep(750); // past when /slow.png would have returned
  assert.deepEqual(await inPage(slow, () => ({
    mark: window.__browserbearMark ?? null,
    host: document.querySelector('browserbear-mark'),
    title: document.title,
  })), { mark: null, host: null, title: 'Slow Icon' }, 'stale paint must not resurrect a released mark');

  assert.deepEqual(await inPage(gmail, () => ({
    title: document.title,
    icoRel: document.getElementById('ico2')?.rel,
    bbLinks: document.querySelectorAll('link[data-browserbear]').length,
    host: document.querySelector('browserbear-mark'),
  })), {
    title: '(2) Inbox',
    icoRel: 'icon',
    bbLinks: 0,
    host: null,
  });
});
