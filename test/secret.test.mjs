// browserbear secret: a key shown in a page, into a file, without going
// through the agent's output. AI Studio's (19 Nov) was in the Cloud console's
// frame, where eval couldn't see it, and its Copy buttons did nothing to the
// clipboard of a Chrome that wasn't in front. The real extension in Chrome for
// Testing, as frames need it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { CFT, extensionInChrome, startBear } from './harness.mjs';

// Made up, in Google's format, so snap blanks it.
const KEY = 'AIzaSyD3m0-Fak3Key_ForBrowserBearTest01';
const TOKEN = 'tok-7Hq2Lx9Pz4';

const FRAME = `<!doctype html><title>Credentials</title>
<label>API key <input id="key" readonly value="${KEY}"></label>
<p>Your key: <span id="shown">${KEY}</span></p>
<p>Token: <code id="token">${TOKEN}</code></p>
<p id="empty"></p>
<p>Quoted: <span>"${TOKEN}"</span></p>
<button>Copy the key for the Gemini Reviews project in AI Studio now ${KEY}</button>
<p id="words">two words</p>`;

test('secret writes a key from a cross-origin frame to a private file, printing only its end', { skip: !CFT && 'no Chrome for Testing' }, async (t) => {
  const frames = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(FRAME);
  });
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><title>AI Studio</title><iframe src="http://localhost:${frames.address().port}/" style="width: 600px; height: 300px"></iframe>`);
  });
  for (const s of [server, frames]) {
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    t.after(() => s.close());
  }
  const url = `http://127.0.0.1:${server.address().port}/`;

  const inWorker = await extensionInChrome(t);
  const tabId = await inWorker(`chrome.tabs.create({ url: ${JSON.stringify(url)} }).then((t) => new Promise((r) => setTimeout(() => r(t.id), 2000)))`);
  const { browserbear } = await startBear(t, async ({ op, args }) => {
    if (op === 'tabs') return [{ tabId, url, title: 'AI Studio', active: true }];
    if (op === 'cdp' || op === 'frames') return inWorker(`ops.${op}(${JSON.stringify(args)})`);
    throw new Error(`unexpected op ${op}`);
  });
  const fails = (...a) => browserbear(...a).then(() => assert.fail(`${a.join(' ')} worked`), (e) => String(e.stderr || e.message));
  const TAB = String(tabId);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-secret-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // snap and read show the frame, but not the key, a field's or shown as text.
  const snap = await browserbear('snap', TAB);
  assert.doesNotMatch(snap, new RegExp(KEY));
  const text = await browserbear('read', TAB);
  assert.doesNotMatch(text, new RegExp(KEY));
  assert.match(text, /Your key: \[a key ending st01; browserbear secret saves it to a file\]/);
  assert.doesNotMatch(await browserbear('eval', TAB, `'${KEY}'`), new RegExp(KEY));
  // In an object too, and cut short where snap clips a long name.
  assert.doesNotMatch(await browserbear('eval', TAB, `({ key: '${KEY}', [\`${KEY}\`]: 1 })`), new RegExp(KEY));
  assert.doesNotMatch(await browserbear('eval', TAB, `JSON.parse('['.repeat(60) + '"${KEY}"' + ']'.repeat(60))`), new RegExp(KEY));
  assert.match(snap, /button "Copy the key [^"]*\[part of a key\]…"/);
  assert.doesNotMatch(snap, /AIzaSy/);
  const ref = snap.match(/(e\d+) textbox "API key"/)[1];

  // A field's value, by ref, into a new folder: 700, the file 600.
  const file = path.join(dir, 'gemini', 'api-key');
  const said = await browserbear('secret', TAB, ref, '--to', file);
  assert.equal(said.trim(), `wrote the key (${KEY.length} characters, ending st01) to ${file}, readable only by you`);
  assert.equal(fs.readFileSync(file, 'utf8'), KEY + '\n');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);

  // Already there: only with --replace. An element's text, by selector; a
  // short one doesn't have its end printed.
  assert.match(await fails('secret', TAB, '--css', '#token', '--to', file), /already there; add --replace/);
  assert.equal(fs.readFileSync(file, 'utf8'), KEY + '\n');
  const short = await browserbear('secret', TAB, '--css', '#token', '--to', file, '--replace');
  assert.equal(short.trim(), `wrote the key (${TOKEN.length} characters) to ${file}, readable only by you`);
  assert.equal(fs.readFileSync(file, 'utf8'), TOKEN + '\n');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  // Never over something that isn't a plain file.
  const link = path.join(dir, 'link');
  fs.symlinkSync(path.join(dir, 'elsewhere'), link);
  assert.match(await fails('secret', TAB, '--css', '#token', '--to', link, '--replace'), /isn't a plain file/);
  assert.equal(fs.existsSync(path.join(dir, 'elsewhere')), false);

  // Nothing written for an empty element, one with more than a key in it, or no --to.
  assert.match(await fails('secret', TAB, '--css', '#empty', '--to', path.join(dir, 'a')), /is empty, so nothing was written/);
  assert.match(await fails('secret', TAB, '--css', '#words', '--to', path.join(dir, 'b')), /more than one word/);
  assert.match(await fails('secret', TAB, ref), /secret needs --to <file>/);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['gemini', 'link']);

  // Several matches: the error doesn't quote them, as they'd be the key.
  const several = await fails('secret', TAB, '--css', 'span, code', '--to', path.join(dir, 'c'));
  assert.match(several, /matches several elements/);
  assert.doesNotMatch(several, new RegExp(`${KEY}|${TOKEN}`));
});
