// download saves under BrowserBear's own folder, never ~/Downloads (which
// macOS keeps agents out of): from the extension's fetch in chunks, or, for
// the agents' browser and older extensions, from a fetch inside the page.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { CHROME, headlessChrome, startBear } from './harness.mjs';

test('download pulls the extension fetch in chunks into the out folder', async (t) => {
  // Over two chunks' worth, so the pieces have to join up in order.
  const bytes = Buffer.alloc(9 * 1024 * 1024 + 7);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) & 0xff;
  const asked = [];
  const { browserbear, home } = await startBear(t, ({ op, args }) => {
    asked.push(op);
    if (op === 'tabs') return [{ tabId: 1, url: 'https://mail.example.com/', title: 'Mail', active: true }];
    if (op === 'fetchFile') {
      if (args.url.endsWith('/gone')) throw new Error(`HTTP 403 Forbidden from ${args.url}`);
      assert.equal(args.url, 'https://mail.example.com/att?id=1');
      return { id: 'f1', size: bytes.length, type: 'application/pdf', disposition: `attachment; filename="news.pdf"; filename*=UTF-8''Dec%20news.pdf`, url: args.url };
    }
    if (op === 'fetchChunk') return bytes.subarray(args.offset, args.offset + args.length).toString('base64');
    throw new Error(`unknown op ${op}`);
  });

  const out = JSON.parse(await browserbear('download', '1', 'https://mail.example.com/att?id=1'));
  assert.equal(path.basename(out.path), 'Dec news.pdf');
  assert.ok(out.path.startsWith(path.join(home, 'out', 'downloads') + path.sep));
  assert.equal(out.bytes, bytes.length);
  assert.equal(out.type, 'application/pdf');
  assert.ok(fs.readFileSync(out.path).equals(bytes));
  assert.equal(asked.filter((op) => op === 'fetchChunk').length, 3);

  // A name the agent gives can't climb out of the folder.
  const named = JSON.parse(await browserbear('download', '1', 'https://mail.example.com/att?id=1', '../../escape.pdf'));
  assert.equal(path.basename(named.path), 'escape.pdf');
  assert.ok(named.path.startsWith(path.join(home, 'out', 'downloads') + path.sep));

  // --to moves it into a folder of the agent's.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browserbear-to-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const moved = JSON.parse(await browserbear('download', '1', 'https://mail.example.com/att?id=1', '--to', dir));
  assert.equal(moved.path, path.join(dir, 'Dec news.pdf'));
  assert.ok(fs.readFileSync(moved.path).equals(bytes));
  // ...without replacing what's there: a server's name mustn't clobber a file.
  const again = JSON.parse(await browserbear('download', '1', 'https://mail.example.com/att?id=1', '--to', dir));
  assert.equal(again.path, path.join(dir, 'Dec news (2).pdf'));
  await assert.rejects(browserbear('download', '1', 'https://mail.example.com/att?id=1', '--to', moved.path), /already there/);
  assert.ok(fs.readFileSync(moved.path).equals(bytes));

  // A name too long for macOS is cut down, keeping its extension.
  const long = JSON.parse(await browserbear('download', '1', 'https://mail.example.com/att?id=1', `${'é'.repeat(300)}.pdf`));
  assert.match(path.basename(long.path), /^é+\.pdf$/);
  assert.ok(Buffer.byteLength(path.basename(long.path)) <= 200);

  // A failed fetch says so rather than falling back.
  await assert.rejects(browserbear('download', '1', 'https://mail.example.com/gone'), /HTTP 403/);
  assert.ok(!asked.includes('cdp'));
});

test('download falls back to a fetch in the page, with relative links', { skip: !fs.existsSync(CHROME) && 'no Chrome' }, async (t) => {
  const file = Buffer.from('%PDF-1.4 not really\n');
  const other = Buffer.from('%PDF-1.4 a different one\n');
  const server = http.createServer((req, res) => {
    if (req.url === '/files/report.pdf') {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      return res.end(file);
    }
    if (req.url === '/files/other.pdf') {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      return res.end(other);
    }
    if (req.url === '/missing') return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<a href="files/report.pdf">Report</a>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/inbox`;

  const send = await headlessChrome(t);
  const { targetId } = await send('Target.createTarget', { url });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const page = (method, params) => send(method, params, sessionId);
  for (let i = 0; i < 50; i++) {
    const { result } = await page('Runtime.evaluate', { expression: 'document.readyState' });
    if (result.value === 'complete') break;
    await new Promise((r) => setTimeout(r, 100));
  }

  const { browserbear, home } = await startBear(t, ({ op, args }) => {
    if (op === 'tabs') return [{ tabId: 1, url, title: 'Inbox', active: true }];
    if (op === 'cdp') return page(args.method, args.params);
    // As the agents' browser, or an extension from before fetchFile, says.
    throw new Error(`unknown op ${op}`);
  });

  // A page that swaps fetch out can't hand over bytes of its own.
  await page('Runtime.evaluate', { expression: 'window.fetch = async () => new Response("forged"); window.URL = function () { return { href: "http://evil.example/" }; }' });
  const out = JSON.parse(await browserbear('download', '1', 'files/report.pdf'));
  assert.equal(path.basename(out.path), 'report.pdf');
  assert.ok(out.path.startsWith(path.join(home, 'out', 'downloads') + path.sep));
  assert.ok(fs.readFileSync(out.path).equals(file));

  // Two at once in one tab each keep their own bytes.
  const [a, b] = await Promise.all(['files/report.pdf', 'files/other.pdf'].map(async (u) => JSON.parse(await browserbear('download', '1', u))));
  assert.ok(fs.readFileSync(a.path).equals(file));
  assert.ok(fs.readFileSync(b.path).equals(other));

  await assert.rejects(browserbear('download', '1', '/missing'), /HTTP 404/);
});
