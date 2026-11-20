import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startBear, root, CFT, extensionInChrome } from './harness.mjs';
import { createHandoffWatch, looksLikeSignIn, urlMatches, UntilAlreadyMet } from '../service/handoff-wait.mjs';

const look = (url, more = {}) => ({ url, title: 'Page', status: 'complete', signInForm: false, text: false, ...more });
const PWD = 'https://accounts.google.com/v3/signin/challenge/pwd?continue=https://console.cloud.google.com/apis/credentials';

// Feeds looks to a watch at the given times, and returns the first answer with its time.
function play(looks, options = {}) {
  const watch = createHandoffWatch({ start: 0, ...options });
  for (const [at, l] of looks) {
    const why = watch.see(l, at);
    if (why) return { at, why };
  }
  return null;
}

test('sign-in pages are told apart from the ones they lead to', () => {
  for (const url of [PWD, 'https://login.qantas.com/', 'https://github.com/login', 'https://github.com/sessions/two-factor', 'https://x.com/oauth2/authorize', 'https://example.com/auth/callback', 'https://accounts.google.com/signin/oauth/consent', 'https://id.atlassian.com/manage']) {
    assert.ok(looksLikeSignIn(url), url);
  }
  // The query doesn't count (Google's names where you're going), or the middle of a word.
  for (const url of ['https://console.cloud.google.com/apis/credentials', 'https://example.com/authors/verified-buyers?next=/login']) {
    assert.ok(!looksLikeSignIn(url), url);
  }
});

test('--until-url patterns', () => {
  assert.ok(urlMatches('*console.cloud.google.com/*', 'https://console.cloud.google.com/apis?x=1'));
  assert.ok(urlMatches('console.cloud.google.com/*', 'https://console.cloud.google.com/apis'));
  assert.ok(urlMatches('https://a.com/*/done', 'https://a.com/x/y/done'));
  assert.ok(urlMatches('/done', 'https://a.com/done?x=1'));
  assert.ok(!urlMatches('a.com/*', 'https://evil.com/a.com/x'));
  // The dot is a dot.
  assert.ok(!urlMatches('a.com/*', 'https://axcom/x'));
});

test("the whole of Google's sign-in, code page and hops included, is one job", () => {
  const seen = play([
    [0, look(PWD, { signInForm: true })],
    [1500, look(PWD, { signInForm: true })],
    [9000, look('https://accounts.google.com/v3/signin/challenge/totp')],
    [20000, look('https://accounts.google.com/v3/signin/challenge/totp')],
    [30000, look('https://accounts.google.com/CheckCookie', { status: 'loading' })],
    [31000, look('https://accounts.youtube.com/accounts/SetSID', { status: 'loading' })],
    [32000, look('https://console.cloud.google.com/apis/credentials', { status: 'loading' })],
    [33500, look('https://console.cloud.google.com/apis/credentials')],
    // Still loaded, but only just got here.
    [34000, look('https://console.cloud.google.com/apis/credentials')],
    [35000, look('https://console.cloud.google.com/apis/credentials')],
  ]);
  assert.deepEqual(seen, { at: 35000, why: 'the tab left the page it was handed over on' });
});

test('finishing without the address changing, or by coming back to it', () => {
  // A wrong password reloads the same page: not finished.
  assert.equal(play([[0, look(PWD, { signInForm: true })], [9000, look(PWD, { signInForm: true })]]), null);
  // The page just sitting there: not finished.
  assert.equal(play([[0, look('https://a.com/pay')], [99000, look('https://a.com/pay')]]), null);
  // A form in an ordinary page goes away.
  assert.match(play([[0, look('https://a.com/app', { signInForm: true })], [3000, look('https://a.com/app')]]).why, /form on the page has gone/);
  // The page couldn't be asked: that's not the form going.
  assert.equal(play([[0, look('https://a.com/app', { signInForm: true })], [3000, look('https://a.com/app', { signInForm: null })]]), null);
  // Off to a sign-in and back to where it started.
  const back = play([[0, look('https://a.com/app')], [1000, look('https://login.a.com/')], [5000, look('https://a.com/app')], [8000, look('https://a.com/app')]]);
  assert.match(back.why, /went away and came back/);
  // A password field on a page with an ordinary address is still a sign-in.
  assert.equal(play([[0, look('https://a.com/')], [1000, look('https://a.com/gate', { signInForm: true })], [9000, look('https://a.com/gate', { signInForm: true })]]), null);
  // A page that failed to load isn't where they were going.
  assert.equal(play([[0, look(PWD)], [1000, look('https://a.com/', { loadError: 'net::ERR_FAILED' })], [9000, look('https://a.com/', { loadError: 'net::ERR_FAILED' })]]), null);
  // A page that never stops loading still counts, once it's been quiet a while.
  assert.ok(play([[0, look(PWD)], [1000, look('https://a.com/', { status: 'loading' })], [9000, look('https://a.com/', { status: 'loading' })], [17000, look('https://a.com/', { status: 'loading' })]]));
});

test('handed off mid-redirect, the page it lands on is the handoff page', () => {
  assert.equal(
    play([[0, look('https://a.com/hop', { status: 'loading' })], [1000, look('https://a.com/pay')], [9000, look('https://a.com/pay')]]),
    null,
  );
});

test('--until flags replace the guessing', () => {
  const pay = { untilText: 'Payment received' };
  // Leaving the page isn't enough when you've said what finished looks like.
  assert.equal(play([[0, look('https://a.com/pay')], [3000, look('https://a.com/pay')], [9000, look('https://a.com/pay/2')]], pay), null);
  assert.match(play([[0, look('https://a.com/pay')], [3000, look('https://a.com/pay')], [9000, look('https://a.com/pay/2', { text: true })]], pay).why, /Payment received/);
  const url = { untilUrl: '*a.com/done*' };
  assert.equal(play([[0, look('https://a.com/pay')], [3000, look('https://a.com/pay')], [9000, look('https://a.com/pay/2')]], url), null);
  assert.equal(play([[0, look('https://a.com/pay')], [3000, look('https://a.com/pay')], [9000, look('https://a.com/done', { status: 'loading' })]], url), null);
  assert.ok(play([[0, look('https://a.com/pay')], [3000, look('https://a.com/pay')], [9000, look('https://a.com/done')]], url));
});

test('--until already true where the tab was handed over is an error, not finished', () => {
  // Scaleway, 20 Nov: handed over on the onboarding page, which --until-url already matched.
  const ONBOARD = 'https://console.scaleway.com/onboarding?isAccountCreated=yes';
  const url = { untilUrl: 'https://console.scaleway.com/*' };
  assert.throws(() => play([[0, look(ONBOARD)]], url), (e) => e instanceof UntilAlreadyMet && /--until-url https:\/\/console\.scaleway\.com\/\* is already true .*onboarding/.test(e.message));
  // Redirected there by itself in the first few seconds, all the same, once it's loaded.
  assert.throws(() => play([[0, look('https://a.com/hop', { status: 'loading' })], [1500, look(ONBOARD, { status: 'loading' })], [3000, look(ONBOARD)]], url), UntilAlreadyMet);
  // Passing through a matching address on the way somewhere else isn't being there.
  assert.equal(play([[0, look('https://console.scaleway.com/dashboard', { status: 'loading' })], [1500, look('https://login.scaleway.com/')], [4500, look('https://login.scaleway.com/')]], url), null);
  // Text it has already, or draws a moment after loading.
  const text = { untilText: 'Dashboard' };
  assert.throws(() => play([[0, look('https://a.com/app', { text: false })], [1500, look('https://a.com/app', { text: true })]], text), /--until-text "Dashboard" is already true/);
  // With both, both must be true from the start for it to be an error...
  const both = { ...url, untilText: 'Dashboard' };
  assert.throws(() => play([[0, look(ONBOARD, { text: true })]], both), /--until-url .* with --until-text "Dashboard"/);
  // ...and the text alone then says when they've finished.
  assert.equal(play([[0, look(ONBOARD)], [3000, look(ONBOARD)], [9000, look(ONBOARD + '&step=2')]], both), null);
  assert.equal(play([[0, look(ONBOARD)], [3000, look(ONBOARD)], [9000, look('https://console.scaleway.com/dashboard', { text: true })]], both).why, 'the tab reached https://console.scaleway.com/* and "Dashboard" is on the page');
  // The first look counts as the start even if it comes late (the service was restarting).
  assert.throws(() => play([[30000, look(ONBOARD)]], url), UntilAlreadyMet);
  // Done still finishes it, whatever the page.
  assert.match(play([[0, look(ONBOARD, { doneClicked: true })]], url).why, /clicked Done/);
});

test('the start lasts until the page has been seen loaded, still and asked', () => {
  const app = 'https://a.com/app';
  const text = { untilText: 'Dashboard' };
  // The probe can't ask the page for the first few seconds, then can: still the start.
  assert.throws(() => play([[0, look(app, { text: null })], [3000, look(app, { text: null })], [6000, look(app, { text: null })], [7500, look(app, { text: true })]], text), UntilAlreadyMet);
  // Loading the whole time, then drawing the text: still the start.
  assert.throws(() => play([[0, look(app, { status: 'loading' })], [6000, look(app, { status: 'loading' })], [7000, look(app)], [8000, look(app, { text: true })]], text), UntilAlreadyMet);
  // Handed over on a page that failed to load: not an error, and it finishes once it loads.
  const url = { untilUrl: '*a.com/done*' };
  const failed = look('https://a.com/done', { loadError: 'net::ERR_CONNECTION_REFUSED' });
  assert.ok(play([[0, failed], [3000, failed], [9000, failed], [20000, look('https://a.com/done')]], url));
  // A redirect late in the start settles all over again.
  const both = { untilUrl: '*/onboarding*', untilText: 'Dashboard' };
  const hop = look('https://a.com/hop');
  assert.throws(() => play([[0, hop], [1500, hop], [3000, hop], [4500, look('https://a.com/onboarding', { status: 'loading' })], [6000, look('https://a.com/onboarding', { text: true })]], both), UntilAlreadyMet);
  // Loading for a while, then drawing the text a moment after it loads: still the start.
  assert.throws(() => play([[0, look(app, { status: 'loading' })], [1500, look(app, { status: 'loading' })], [3000, look(app, { status: 'loading' })], [4500, look(app, { status: 'loading' })], [6000, look(app)], [7500, look(app, { text: true })]], text), UntilAlreadyMet);
  // A query change starts the page loading again, however long the path's been there.
  const stage = { untilUrl: '*stage=done*' };
  const pay = look('https://a.com/checkout?stage=pay');
  assert.equal(play([[0, pay], [3000, pay], [20000, look('https://a.com/checkout?stage=done', { status: 'loading' })]], stage), null);
});

test('--until-url and --until-text together wait for both', () => {
  const both = { untilUrl: '*a.com/done*', untilText: 'Paid' };
  assert.equal(play([[0, look('https://a.com/pay')], [3000, look('https://a.com/pay')], [9000, look('https://a.com/done')]], both), null);
  assert.equal(play([[0, look('https://a.com/pay')], [3000, look('https://a.com/pay')], [9000, look('https://a.com/pay/2', { text: true })]], both), null);
  // The text being there is enough to go on while the page still loads.
  assert.equal(
    play([[0, look('https://a.com/pay')], [3000, look('https://a.com/pay')], [9000, look('https://a.com/done', { text: true, status: 'loading' })]], both).why,
    'the tab reached *a.com/done* and "Paid" is on the page',
  );
  // A query change counts, for an address that says where you are in it.
  assert.ok(play([[0, look('https://a.com/checkout?stage=pay')], [3000, look('https://a.com/checkout?stage=pay')], [6000, look('https://a.com/checkout?stage=done')]], { untilUrl: '*stage=done*' }));
});

test('--wait --until-url already true at the start: exits 1 and says why', async (t) => {
  const { world, run } = await waitingBear(t, 'https://console.scaleway.com/onboarding');
  world.signInForm = false;
  const { code, out } = await run('--until-url', 'https://console.scaleway.com/*').done;
  assert.equal(code, 1);
  assert.match(out, /browserbear: --until-url https:\/\/console\.scaleway\.com\/\* is already true on the page the tab was handed over on/);
  assert.doesNotMatch(out, /the user has finished/);
});

test('--wait: an address and an answer from different pages are no answer', async (t) => {
  const { world, run, until } = await waitingBear(t, 'https://a.com/start');
  world.signInForm = false;
  // In BrowserBear's window the whole time, as every tab in the agents' browser is.
  world.tab.bear = true;
  const wait = run('--until-url', '*a.com/done*', '--until-text', 'Paid', '--timeout', '12');
  await until(() => world.marks.at(-1)?.finish === true);
  await new Promise((r) => setTimeout(r, 6000));
  // The tab's on /done (no "Paid") when it's listed, then on /review ("Paid") when asked.
  world.tab.url = 'https://a.com/done';
  world.onProbe = () => {
    world.tab.url = world.tab.url === 'https://a.com/done' ? 'https://a.com/review' : 'https://a.com/done';
    world.text = world.tab.url === 'https://a.com/review';
  };
  const { code, out } = await wait.done;
  assert.equal(code, 124, out);
});

test('Done, and being moved back to BrowserBear\'s window, finish it wherever the page is', () => {
  assert.match(play([[0, look(PWD)], [1000, look(PWD, { doneClicked: true })]]).why, /clicked Done/);
  assert.match(play([[0, look(PWD)], [1000, look(PWD, { bear: true })]]).why, /moved it back/);
  // Had nowhere to go (it never left BrowserBear's window): that isn't being moved back.
  assert.equal(play([[0, look(PWD, { bear: true })], [1000, look(PWD, { bear: true })]]), null);
});

// Started by hand, not through startBear's browserbear, to get its exit code and see it while it runs.
function runCli(env, ...args) {
  const p = spawn(process.execPath, [path.join(root, 'cli.mjs'), ...args], { env });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  return { done: new Promise((r) => p.on('close', (code) => r({ code, out }))), output: () => out };
}

// The CLI against the real service, with a fake extension whose tab the test moves around.
async function waitingBear(t, first, extraEnv) {
  const tab = { tabId: 8, url: first, title: 'Sign in', status: 'complete', active: true, agent: true };
  const world = { tab, closed: false, marks: [], signInForm: true, debugger: 0, text: false };
  const bear = await startBear(
    t,
    ({ op, args }) => {
      if (op === 'tabs') return world.closed ? [] : [tab];
      if (op === 'handoff') return tab;
      if (op === 'mark') return world.marks.push(args.mark), true;
      if (op === 'probe') return world.onProbe?.(), { signInForm: world.signInForm, text: world.text };
      if (op === 'cdp') world.debugger++;
      throw new Error(`unexpected op ${op}`);
    },
    { BROWSERBEAR_THANKS_MS: '600', BROWSERBEAR_MARK_TICK_MS: '100', ...extraEnv },
  );
  const run = (...a) => runCli(bear.env, 'handoff', '8', '--wait', ...a);
  const until = async (want) => {
    for (let i = 0; i < 100; i++) {
      if (want()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.fail(`never happened; marks were ${JSON.stringify(world.marks)}`);
  };
  return { ...bear, world, run, until };
}

test('--wait: the tab reaches its destination, the bar says thanks, the CLI says where', async (t) => {
  const { world, run, until, browserbear } = await waitingBear(t, PWD);
  const wait = run();
  await until(() => wait.output().includes('in front of the user'));
  assert.match(wait.output(), /they don't need to reply/);
  // Over to you, with a Done button for as long as the wait is watching.
  await until(() => world.marks.at(-1)?.finish === true);
  assert.equal(world.marks.at(-1).state, 'yours');

  Object.assign(world.tab, { url: 'https://console.cloud.google.com/apis/credentials', title: 'Credentials' });
  world.signInForm = false;
  const { code, out } = await wait.done;
  assert.equal(code, 0);
  assert.match(out, /the user has finished in tab 8 .*It's now on: Credentials <https:\/\/console\.cloud\.google\.com\/apis\/credentials>/);
  // It never touched the debugger on the user's tab.
  assert.equal(world.debugger, 0);
  // Green, then gone.
  const thanks = world.marks.find((m) => m?.thanks);
  assert.deepEqual(thanks, { name: 'agent', url: null, state: 'working', action: 'Thanks, carrying on', stop: false, thanks: true });
  await until(() => world.marks.at(-1) === null);
  assert.doesNotMatch(await browserbear('tabs'), /🐻/);
});

test('--wait: Done on the bar finishes it, for a page that never changes', async (t) => {
  const { world, run, until, fromExtension } = await waitingBear(t, 'https://a.com/approve');
  const wait = run();
  await until(() => world.marks.at(-1)?.finish === true);
  fromExtension({ type: 'event', event: 'mark', action: 'done', tabId: 8 });
  const { code, out } = await wait.done;
  assert.equal(code, 0);
  assert.match(out, /they clicked Done/);
});

test('--wait: closing the tab exits 2 and says so', async (t) => {
  const { world, run, until } = await waitingBear(t, PWD);
  const wait = run();
  await until(() => world.marks.at(-1)?.finish === true);
  world.closed = true;
  const { code, out } = await wait.done;
  assert.equal(code, 2);
  assert.match(out, /tab 8 was closed before they finished; it was last on Sign in/);
});

test('--wait: the timeout exits 124 and says where the tab is', async (t) => {
  const { run } = await waitingBear(t, PWD);
  const { code, out } = await run('--timeout', '2').done;
  assert.equal(code, 124);
  assert.match(out, /timed out after 2 s .*still on Sign in/);
});

test('--wait: ✕ on the bar leaves it off, and the wait still ends', async (t) => {
  const { world, run, until, fromExtension } = await waitingBear(t, PWD);
  const wait = run();
  await until(() => world.marks.at(-1)?.finish === true);
  fromExtension({ type: 'event', event: 'mark', action: 'release', tabId: 8 });
  await until(() => world.marks.at(-1) === null);
  const count = world.marks.length;
  Object.assign(world.tab, { url: 'https://console.cloud.google.com/' });
  world.signInForm = false;
  assert.equal((await wait.done).code, 0);
  assert.equal(world.marks.length, count, 'no bar came back, not even the thanks');
});

test('--until-text on an extension too old to answer says so rather than wait for ever', async (t) => {
  const tab = { tabId: 8, url: PWD, title: 'Sign in', status: 'complete', agent: true };
  const { env } = await startBear(t, ({ op }) => {
    if (op === 'tabs') return [tab];
    if (op === 'handoff') return tab;
    if (op === 'mark') return true;
    throw new Error(`unknown op ${op}`);
  });
  const { code, out } = await runCli(env, 'handoff', '8', '--until-text', 'hi', '--timeout', '30').done;
  assert.equal(code, 1);
  assert.match(out, /too old for --until-text/);
});

test('the real extension answers the question without a debugger, and draws the bar', { skip: !CFT && 'needs Playwright Chromium' }, async (t) => {
  const pages = {
    '/form': '<title>Sign in</title><p>Payment\n RECEIVED</p><iframe srcdoc="<input type=password>"></iframe>',
    // Google's first step keeps a hidden one.
    '/hidden': '<title>Email</title><input type=password style="display:none"><input type=email>',
  };
  const server = http.createServer((req, res) => res.setHeader('content-type', 'text/html').end(pages[req.url] || ''));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const inWorker = await extensionInChrome(t);
  const open = (p) => inWorker(`ops.open({ url: '${base}${p}' }).then((t) => t.tabId)`);

  const form = await open('/form');
  assert.deepEqual(await inWorker(`ops.probe({ tabId: ${form}, text: 'payment received' })`), { signInForm: true, text: true });
  assert.deepEqual(await inWorker(`ops.probe({ tabId: ${form}, text: 'nope' })`), { signInForm: true, text: false });
  const hidden = await open('/hidden');
  assert.deepEqual(await inWorker(`ops.probe({ tabId: ${hidden} })`), { signInForm: false, text: false });
  // Nothing can script this page: that's "couldn't ask", not "no form".
  const blocked = await inWorker(`chrome.tabs.create({ url: 'chrome://version' }).then((t) => t.id)`);
  assert.deepEqual(await inWorker(`ops.probe({ tabId: ${blocked} })`), { signInForm: null, text: null });
  // The window it opened in is BrowserBear's, and the tab says so.
  const listed = await inWorker(`ops.tabs().then((tabs) => tabs.find((t) => t.tabId === ${form}))`);
  assert.equal(listed.bear, true);

  // Handing a tab over lets go of the debugger straight away, rather than when it next goes idle.
  const attached = () => inWorker(`chrome.debugger.getTargets().then((all) => all.find((x) => x.tabId === ${hidden}).attached)`);
  await inWorker(`ops.cdp({ tabId: ${hidden}, method: 'Runtime.evaluate', params: { expression: '1' } })`);
  assert.equal(await attached(), true);
  await inWorker(`ops.handoff({ tabId: ${hidden} })`);
  assert.equal(await attached(), false);

  const pill = () =>
    inWorker(`chrome.scripting.executeScript({ target: { tabId: ${form} }, func: () => {
      const p = window.__browserbearMark.parts;
      return { pill: p.pill.className, glow: p.glow.className, done: p.done.style.display, open: p.open.style.display, text: p.text.textContent, bg: getComputedStyle(p.pill).backgroundColor };
    } }).then(([r]) => r.result)`);
  await inWorker(`ops.mark({ tabId: ${form}, mark: { name: 'Brief', url: 'threadbear://thread/x', state: 'yours', action: 'over to you', stop: false, finish: true } })`);
  const yours = await pill();
  assert.equal(yours.done, '');
  assert.equal(yours.text, '🐻 Brief · over to you');
  assert.equal(yours.bg, 'rgb(17, 24, 39)');
  await inWorker(`ops.mark({ tabId: ${form}, mark: { name: 'Brief', url: null, state: 'working', action: 'Thanks, carrying on', stop: false, thanks: true } })`);
  const thanks = await pill();
  assert.equal(thanks.pill, 'pill working thanks fading');
  assert.equal(thanks.glow, 'glow fading');
  assert.equal(thanks.done, 'none');
  assert.equal(thanks.open, 'none');
  assert.equal(thanks.text, '🐻 Brief · Thanks, carrying on');
  assert.equal(thanks.bg, 'rgb(21, 128, 61)');
});
