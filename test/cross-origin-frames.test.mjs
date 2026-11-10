// A form in a cross-origin iframe, as Google Play's "Create a payments
// profile" dialog is (payments.google.com inside play.google.com, 10 Nov):
// snap showed a bare [dialog], read had none of its text, and type had
// nothing to type into. 127.0.0.1 and localhost are different sites, so
// Chrome puts the frame in its own process, the way it does there. The real
// extension does the attaching, in Chrome for Testing; the test plays only
// its tab list. Skipped without Playwright's Chromium.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { CFT, extensionInChrome, startBear } from './harness.mjs';

const TOP = (framePort, samePort) => `<!doctype html><title>Signup</title>
<h1>Create a developer account</h1>
<button id="outside">Outside</button>
<iframe src="http://127.0.0.1:${samePort}/" style="height: 60px"></iframe>
<iframe src="/same" style="height: 60px"></iframe>
<div style="margin: 300px 0 0 120px" role="dialog" aria-label="Create a payments profile">
  <iframe src="http://localhost:${framePort}/frame" style="width: 420px; height: 240px; border: 7px solid #ccc"></iframe>
</div>
<iframe src="http://localhost:${framePort}/helper" style="display: none"></iframe>
<iframe src="http://localhost:${framePort}/helper" width="0" height="0" style="border: 0"></iframe>
<iframe src="http://localhost:${framePort}/helper"></iframe>
<iframe src="http://localhost:${framePort}/nest" style="opacity: 0"></iframe>
<iframe src="http://localhost:${framePort}/contents"></iframe>`;

const FRAME = `<!doctype html><title>Payments</title>
<p>Verify your identity</p>
<label>D-U-N-S number <input id="duns"></label>
<p id="said">not clicked</p>
<input type="file" id="id-doc" hidden>
<button style="margin-top: 60px" onclick="said.textContent = 'clicked with ' + duns.value">Verify</button>`;

// A helper frame with nothing to read, like the hidden
// studio.workspace.google.com one in Gmail, whose inline scripts read
// printed as text (11 Nov). The page has it hidden, at 0x0 and shown.
const HELPER = `<!doctype html><script>window.IJ_values = ['helper script'];</script>
<style>.x { color: red }</style><noscript>helper noscript</noscript><div hidden>helper hidden div</div>`;

// A frame shown inside a hidden one is hidden too; a body with
// display:contents is still drawn (Codex's review, 11 Nov).
const NEST = (port) => `<iframe src="http://127.0.0.1:${port}/nested"></iframe>`;
const CONTENTS = '<body style="display: contents"><p>Payment instructions</p></body>';

// Another port on the same host is cross-origin but the same site, so it
// shares the page's process: no session of its own, and still not in the
// page's own tree (Codex's review, 10 Nov).
// Its own iframe shares the process too, and has to go in where it is.
const SAME_SITE = `<p>Same site</p><button onclick="this.textContent = 'Pressed'">Accept</button>
<label for="upload">Upload</label><input id="upload" type="file" hidden>
<iframe src="/inner"></iframe>`;

test('snap, read, click and type reach into a cross-origin iframe', { skip: !CFT && 'no Chrome for Testing' }, async (t) => {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(req.url === '/helper' ? HELPER : req.url === '/nest' ? NEST(sameSite.address().port) : req.url === '/contents' ? CONTENTS : req.url === '/frame' ? FRAME : req.url === '/same' ? '<button>Same origin</button>' : TOP(server.address().port, sameSite.address().port));
  });
  const sameSite = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(req.url === '/inner' ? '<button>Inner</button>' : req.url === '/nested' ? '<p>Nested in a hidden frame</p>' : SAME_SITE);
  });
  for (const s of [server, sameSite]) {
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    t.after(() => s.close());
  }
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/`;

  const inWorker = await extensionInChrome(t);
  const tabId = await inWorker(`chrome.tabs.create({ url: ${JSON.stringify(url)} }).then((t) => new Promise((r) => setTimeout(() => r(t.id), 2000)))`);
  const frameText = (js) =>
    inWorker(`ops.frames({ tabId: ${tabId} }).then((fs) => fs.find((f) => f.url.endsWith('/frame'))).then((f) => ops.cdp({ tabId: ${tabId}, sessionId: f.sessionId, method: 'Runtime.evaluate', params: { expression: ${JSON.stringify(js)}, returnByValue: true } })).then((r) => r.result.value)`);

  const { browserbear } = await startBear(t, async ({ op, args }) => {
    if (op === 'tabs') return [{ tabId, url, title: 'Signup', active: true }];
    if (op === 'cdp' || op === 'frames') return inWorker(`ops.${op}(${JSON.stringify(args)})`);
    throw new Error(`unexpected op ${op}`);
  });

  // The frame's controls, inside the dialog that holds them.
  const snap = await browserbear('snap', String(tabId));
  assert.match(snap, /\[dialog "Create a payments profile"\]\n\[frame localhost:\d+\]\ne\d+ textbox "D-U-N-S number"\ne\d+ button "Verify"/);
  assert.match(snap, /e\d+ button "Outside"/);
  const ref = (name) => snap.match(new RegExp(`(e\\d+) \\w+ "${name}"`))[1];
  // Each once: none of the frames is in the page's tree twice.
  assert.match(snap, /button "Accept"\n\[frame 127\.0\.0\.1:\d+\]\ne\d+ button "Inner"\ne\d+ file-input "Upload" #upload \[hidden\]\n/);
  assert.match(snap, /e\d+ file-input #id-doc \[hidden\]/);
  for (const name of ['Accept', 'Same origin', 'Verify', 'Inner']) assert.equal(snap.split(`button "${name}"`).length, 2, `${name} in:\n${snap}`);

  const text = await browserbear('read', String(tabId));
  assert.match(text, /Create a developer account[\s\S]*\[frame localhost:\d+\]\nVerify your identity/);
  assert.match(text, /\[frame 127\.0\.0\.1:\d+\]\nSame site/);
  assert.doesNotMatch(text, /IJ_values|helper|color: red/);
  assert.doesNotMatch(text, /Nested in a hidden frame/);
  assert.match(text, /\[frame localhost:\d+\]\nPayment instructions/);
  assert.equal(text.match(/\[frame localhost:\d+\]/g).length, 2, text);

  assert.match(await browserbear('click', String(tabId), ref('Accept')), /button "Pressed"/);

  await browserbear('type', String(tabId), ref('D-U-N-S number'), '750026836');
  assert.equal(await frameText('duns.value'), '750026836');

  // A real click: it has to land where the button is on screen, past the
  // frame's margin and border.
  const clicked = await browserbear('click', String(tabId), ref('Verify'));
  assert.doesNotMatch(clicked, /script click/);
  assert.equal(await frameText('said.textContent'), 'clicked with 750026836');

  // The extension lets go after 30 s idle, which ends the frame's session;
  // the same refs still work once it's back.
  await inWorker(`ops.detach ? ops.detach({ tabId: ${tabId} }) : chrome.debugger.detach({ tabId: ${tabId} })`).catch(() => {});
  await browserbear('type', String(tabId), ref('D-U-N-S number'), '1', '--replace');
  assert.equal(await frameText('duns.value'), '1');

  // A hidden file input in the frame takes an upload by its ref.
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bb-frames-')), 'duns.pdf');
  fs.writeFileSync(file, '%PDF-1.4');
  await browserbear('upload', String(tabId), snap.match(/(e\d+) file-input #id-doc/)[1], file);
  assert.equal(await frameText("document.querySelector('#id-doc').files[0]?.name"), 'duns.pdf');

  // With no ref, type goes wherever focus is, which is in the frame now.
  await browserbear('type', String(tabId), '-', '2');
  assert.equal(await frameText('duns.value'), '12');
});
