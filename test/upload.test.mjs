// upload against test/pages/upload.html in real headless Chrome: the test
// plays the extension and passes its CDP calls straight to that Chrome, so the
// page scripts, the picker catching and DOM.setFileInputFiles are all real.
// Skipped where Chrome isn't installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CHROME, headlessChrome, root, startBear } from './harness.mjs';

test('upload finds the file input behind buttons, labels and selectors', { skip: !fs.existsSync(CHROME) && 'no Chrome' }, async (t) => {
  const send = await headlessChrome(t);
  const url = pathToFileURL(path.join(root, 'test', 'pages', 'upload.html')).href;
  const { targetId } = await send('Target.createTarget', { url });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const page = (method, params) => send(method, params, sessionId);
  for (let i = 0; i < 50; i++) {
    const { result } = await page('Runtime.evaluate', { expression: 'document.readyState' });
    if (result.value === 'complete') break;
    await new Promise((r) => setTimeout(r, 100));
  }

  const { browserbear } = await startBear(t, ({ op, args }) => {
    if (op === 'tabs') return [{ tabId: 1, url, title: 'Uploads', active: true }];
    if (op === 'cdp') return page(args.method, args.params);
    throw new Error(`unexpected op ${op}`);
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browserbear-files-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = (name, text) => {
    fs.writeFileSync(path.join(dir, name), text);
    return path.join(dir, name);
  };
  const talk = file('talk.mp3', 'abcd');
  const intro = file('intro.wav', 'ab');
  const output = async (section) => (await page('Runtime.evaluate', { expression: `document.querySelector('#${section} output').textContent`, returnByValue: true })).result.value;

  // Hidden inputs are listed, so there's always something to pass to upload.
  const snap = await browserbear("snap", "1");
  assert.match(snap, /e\d+ button "Choose files"/);
  assert.match(snap, /e\d+ file-input #enhance-file-upload accept="\.mp3,\.wav" \[multiple, hidden\]/);
  assert.match(snap, /e\d+ file-input "Add photo" accept="image\/\*" \[hidden\]/);
  const ref = (name) => snap.match(new RegExp(`(e\\d+) [a-z-]+ "${name}`))[1];

  // Adobe's case: the button's handler clicks the hidden input.
  let out = await browserbear('upload', '1', ref('Choose files'), talk, intro);
  assert.match(out, /2 files set on the file input e\d+ opens when clicked/);
  assert.equal(await output('adobe'), 'talk.mp3 (4), intro.wav (2)');

  // A hidden input, named by the label around it.
  out = await browserbear('upload', '1', ref('Add photo'), talk);
  assert.match(out, /talk\.mp3 set on e\d+/);
  assert.equal(await output('label'), 'talk.mp3 (4)');
  // ...and the label itself, by selector.
  await browserbear('upload', '1', '#label label', intro);
  assert.equal(await output('label'), 'intro.wav (2)');

  // An input that only exists once the button's (async) handler makes it.
  await browserbear('upload', '1', ref('Attach'), intro);
  assert.equal(await output('detached'), 'intro.wav (2)');

  // A CSS selector, straight at the hidden input.
  out = await browserbear('upload', '1', '#enhance-file-upload', intro);
  assert.match(out, /intro\.wav set on "#enhance-file-upload"/);
  assert.equal(await output('adobe'), 'intro.wav (2)');

  // showOpenFilePicker has no input to fill: say so, and the page sees a cancel.
  await assert.rejects(browserbear('upload', '1', ref('Open with the file system API'), talk), /showOpenFilePicker/);
  assert.equal(await output('fsa'), 'AbortError');

  // GOV.UK's photo step: a visually hidden input and a button that opens
  // nothing by itself, so the nearest input it is.
  out = await browserbear('upload', '1', ref('Choose your photo'), talk);
  assert.match(out, /talk\.mp3 set on the file input nearest e\d+/);
  assert.equal(await output('govuk'), 'talk.mp3 (4)');

  await assert.rejects(browserbear('upload', '1', '#nope', talk), /nothing in tab 1 matches the selector "#nope"/);
  await assert.rejects(browserbear('upload', '1', ref('Choose files'), path.join(dir, 'missing.mp3')), /no such file/);
});
