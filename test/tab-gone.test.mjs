// An agent's tab that has gone: the error says why, a profile that's only
// reconnecting isn't taken for one whose tabs are gone, and of two BrowserBear
// extensions in one profile only the newer is used. On 19 Nov 2026 an agent's
// Zoho tab vanished three times in ten minutes (its page closed it twice, and
// Chrome crashed once), and each time it heard only "no tab" or "has closed".
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CFT, extensionInChrome, root, startBear } from './harness.mjs';
import { encodeNative, nativeReader } from '../service/wire.mjs';

const ZOHO = { url: 'https://campaigns.example/campaign/42?token=secret-reset-token#x', title: 'Zoho Campaigns' };
const agentTab = (tabId, more = {}) => ({ tabId, ...ZOHO, active: true, agent: true, bear: true, ...more });

// Another host into the same service, as a second profile (or a second
// extension in the same one) would connect.
function addHost(t, env, hello, onOp) {
  const host = spawn(process.execPath, [path.join(root, 'host', 'browserbear-host.mjs'), 'chrome-extension://y/'], { env });
  host.stdout.on('data', nativeReader(async (msg) => {
    if (msg.type) return;
    try {
      host.stdin.write(encodeNative({ id: msg.id, ok: true, result: await onOp(msg) }));
    } catch (e) {
      host.stdin.write(encodeNative({ id: msg.id, ok: false, error: e.message }));
    }
  }));
  host.stdin.write(encodeNative({ type: 'hello', ...hello }));
  t.after(() => host.kill());
  return host;
}

const until = async (check, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (await check()) return;
  throw new Error('timed out waiting');
};

test('a tab closed in Chrome says when and how', async (t) => {
  let tabs = [agentTab(5)];
  let closed = null;
  const { browserbear } = await startBear(t, ({ op }) => {
    if (op === 'tabs') return tabs;
    if (op === 'closed') return closed;
    if (op === 'started') return null;
    throw new Error(`unexpected op ${op}`);
  });
  assert.match(await browserbear('tabs'), /5\* Zoho Campaigns/);
  tabs = [];
  closed = { at: Date.now(), why: 'chrome' };
  const err = await browserbear('close', '5').then(() => null, (e) => e.stderr || e.message);
  assert.match(err, /tab 5 \("Zoho Campaigns" <https:\/\/campaigns\.example\/campaign\/42>, in .*\) was closed at \d\d:\d\d:\d\d, by the user or by the page itself/);

  assert.doesNotMatch(err, /secret-reset-token/);

  closed = { at: Date.now(), why: 'window' };
  assert.match(await browserbear('close', '5').then(() => null, (e) => e.stderr), /with its whole window/);
});

test('a tab lost to Chrome restarting says so, and where the page is now', async (t) => {
  let tabs = [agentTab(5)];
  let started = 1;
  const { browserbear } = await startBear(t, ({ op }) => {
    if (op === 'tabs') return tabs;
    if (op === 'closed') return null;
    if (op === 'started') return started;
    throw new Error(`unexpected op ${op}`);
  });
  await browserbear('tabs');
  await new Promise((r) => setTimeout(r, 20));
  // Chrome came back with the page restored under a new id, not the agent's.
  started = Date.now();
  tabs = [agentTab(9, { agent: false, bear: false })];
  const err = await browserbear('close', '5').then(() => null, (e) => e.stderr);
  assert.match(err, /went when Chrome (crashed at [\d:]+|\(or that profile\) quit)\. Chrome started again at [\d:]+, and tabs it restores get new ids/);
  assert.match(err, /The same page is open in .* in tab 9 now\. If Chrome restored it/);
  assert.doesNotMatch(err, /claim 9/);
});

test("a profile that's only reconnecting is waited for, not taken for gone", async (t) => {
  const tabs = [agentTab(5)];
  const ops = [];
  const onOp = ({ op }) => {
    ops.push(op);
    if (op === 'tabs') return tabs;
    if (op === 'close') return true;
    throw new Error(`unexpected op ${op}`);
  };
  // Another profile, which has stopped answering: it mustn't hold the wait up.
  const bear = await startBear(t, ({ op }) => {
    if (op === 'tabs') return hung ? new Promise(() => {}) : [];
    throw new Error(`unexpected op ${op}`);
  }, {}, { instance: 'inst-2' });
  let hung = false;
  // The profile with the tab, which then drops (Chrome's port closes) and comes back.
  const hello = { instance: 'inst-1', email: 'you@example.com', version: 'test' };
  const first = addHost(t, bear.env, hello, onOp);
  await until(async () => (await bear.browserbear('status')).includes('you@example.com'));
  await bear.browserbear('tabs', '--profile', 'you@example.com');
  hung = true;
  first.kill();
  await until(async () => !(await bear.browserbear('status')).includes('you@example.com'));
  setTimeout(() => addHost(t, bear.env, hello, onOp), 1500);
  const start = Date.now();
  assert.equal(await bear.browserbear('close', '5'), 'closed tab 5');
  assert.ok(Date.now() - start < 12_000, 'waited on the profile that hung');
});

test('two BrowserBear extensions in one profile are named, and --profile picks the newer', async (t) => {
  const tabs = [agentTab(5), agentTab(6, { agent: false, bear: false })];
  const asked = { new: [], old: [] };
  const onOp = (who) => ({ op }) => {
    asked[who].push(op);
    if (op === 'tabs') return tabs;
    if (op === 'open') return agentTab(8);
    throw new Error(`unexpected op ${op}`);
  };
  const bear = await startBear(t, onOp('new'));
  bear.fromExtension({ type: 'hello', instance: 'inst-1', email: 'me@example.com', version: '0.3.11' });
  addHost(t, bear.env, { instance: 'inst-old', email: 'me@example.com', version: '0.3.8' }, onOp('old'));
  await until(async () => (await bear.browserbear('profiles')).includes('has two BrowserBear extensions, 0.3.11 and 0.3.8'));
  asked.old.length = 0;
  await bear.browserbear('open', '--id', '--profile', 'me@example.com', 'https://campaigns.example/new').catch(() => {});
  assert.ok(asked.new.includes('open'));
  assert.ok(!asked.old.includes('open'));
});

// Two profiles signed in to the same account aren't taken for one.
test('two profiles with the same email but different tabs stay ambiguous', async (t) => {
  const onOp = (tabId) => ({ op }) => {
    if (op === 'tabs') return [agentTab(tabId)];
    throw new Error(`unexpected op ${op}`);
  };
  const bear = await startBear(t, onOp(5));
  bear.fromExtension({ type: 'hello', instance: 'inst-1', email: 'me@example.com', version: '0.3.11' });
  addHost(t, bear.env, { instance: 'inst-2', email: 'me@example.com', version: '0.3.8' }, onOp(6));
  await until(async () => (await bear.browserbear('status')).split('me@example.com').length > 2);
  await new Promise((r) => setTimeout(r, 300));
  assert.doesNotMatch(await bear.browserbear('profiles'), /two BrowserBear extensions/);
  await assert.rejects(bear.browserbear('open', '--profile', 'me@example.com', 'https://campaigns.example/new'), /could be any of/);
});

// The extension itself, in Chrome for Testing.
test("a page can't close an agent's tab, and a closed tab's reason is kept", { skip: !CFT && 'no Chrome for Testing' }, async (t) => {
  const server = http.createServer((req, res) => res.end('<title>Save</title><button onclick="window.close()">Save</button>'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/`;
  const inWorker = await extensionInChrome(t);
  const pageCloses = (tabId) => inWorker(`chrome.scripting.executeScript({ target: { tabId: ${tabId} }, world: 'MAIN', func: () => window.close() })`);
  const alive = (tabId) => inWorker(`chrome.tabs.get(${tabId}).then(() => true, () => false)`);

  const opened = await inWorker(`ops.open({ url: ${JSON.stringify(url)} })`);
  assert.equal(opened.url, url);
  assert.equal(opened.title, 'Save');
  await pageCloses(opened.tabId);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(await alive(opened.tabId), true, "the page's window.close() closed the agent's tab");
  // Its window is BrowserBear's, so the next open lands there, past the same blank start.
  const second = await inWorker(`ops.open({ url: ${JSON.stringify(url)} })`);
  assert.equal(second.windowId, opened.windowId);
  await pageCloses(second.tabId);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(await alive(second.tabId), true);

  await inWorker(`ops.close({ tabId: ${second.tabId} })`);
  const byUs = await inWorker(`ops.closed({ tabId: ${second.tabId} })`);
  assert.equal(byUs.why, 'browserbear');
  await inWorker(`chrome.tabs.remove(${opened.tabId})`);
  assert.equal((await inWorker(`ops.closed({ tabId: ${opened.tabId} })`)).why, 'chrome');
  const win = await inWorker(`chrome.windows.create({ url: ${JSON.stringify(url)} }).then((w) => w.tabs[0].id + ',' + w.id)`);
  const [inWin, winId] = win.split(',').map(Number);
  await inWorker(`chrome.windows.remove(${winId})`);
  assert.equal((await inWorker(`ops.closed({ tabId: ${inWin} })`)).why, 'window');
  assert.equal(await inWorker('ops.closed({ tabId: 999999 })'), null);

  // A URL Chrome won't take leaves no blank tab behind.
  const before = await inWorker('chrome.tabs.query({}).then((t) => t.length)');
  await assert.rejects(inWorker(`ops.open({ url: 'http://[' })`));
  assert.equal(await inWorker('chrome.tabs.query({}).then((t) => t.length)'), before);
});
