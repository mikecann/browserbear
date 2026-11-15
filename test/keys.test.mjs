// Real keys in real headless Chrome. Discord's message box ignored Shift+Enter
// (2 Nov), because the keydown went without its text, so Chrome sent no keypress and
// no beforeinput. Slate editors act on that beforeinput, as this page does.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { CHROME, headlessChrome, startBear } from './harness.mjs';

const PAGE = `<!doctype html><title>Editor</title>
<div id="box" contenteditable role="textbox" aria-label="box"></div>
<script>
window.seen = [];
box.addEventListener('beforeinput', (e) => {
  seen.push(e.inputType);
  // Enter sends in these editors, so the test can tell the two apart.
  if (e.inputType === 'insertParagraph') e.preventDefault();
});
</script>`;

test('Shift+Enter makes a line break in a rich editor', { skip: !fs.existsSync(CHROME) && 'no Chrome' }, async (t) => {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(PAGE);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/`;

  const send = await headlessChrome(t);
  const { targetId } = await send('Target.createTarget', { url });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const TAB = 7;
  const { browserbear } = await startBear(t, ({ op, args }) => {
    if (op === 'tabs') return [{ tabId: TAB, url, title: 'Editor', active: true, windowId: 1, status: 'complete' }];
    if (op === 'cdp') return send(args.method, args.params, sessionId);
    return true;
  });

  for (let i = 0; i < 50 && (await browserbear('eval', String(TAB), 'document.readyState')) !== 'complete'; i++) await new Promise((r) => setTimeout(r, 100));
  await browserbear('eval', String(TAB), 'box.focus()');
  await browserbear('type', String(TAB), '-', 'one');
  await browserbear('key', String(TAB), 'Shift+Enter');
  await browserbear('type', String(TAB), '-', 'two');
  assert.deepEqual(JSON.parse(await browserbear('eval', String(TAB), 'JSON.stringify(seen)')), ['insertText', 'insertLineBreak', 'insertText']);
  assert.match(await browserbear('eval', String(TAB), 'box.innerText'), /^one\ntwo\s*$/);

  // Other modified keys still don't type anything.
  await browserbear('key', String(TAB), 'Shift+Tab');
  await browserbear('key', String(TAB), 'Meta+b');
  assert.match(await browserbear('eval', String(TAB), 'box.innerText'), /^one\ntwo\s*$/);
});

// Google Sheets (16 Nov): "key End" typed the word "End" into a cell, and "type -"
// put text into the cell editor without Sheets noticing. Sheets keeps that editor
// out of sight at -10000px and only starts editing on a keydown, which inserted
// text hasn't got. This page does the same.
const SHEET = `<!doctype html><title>Sheet</title>
<input id="field" value="abc">
<div id="box" style="height: 40px; overflow: auto"><div style="height: 400px"></div><input id="short" maxlength="2"><div style="height: 400px"></div></div>
<div style="position: absolute; top: -10000px; left: 0"><div id="cell" contenteditable style="width: 0; height: 30px"></div></div>
<script>
window.editing = false;
window.committed = null;
window.combos = [];
field.addEventListener('keydown', (e) => e.ctrlKey && combos.push(e.code + ' ' + e.keyCode));
cell.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); if (editing) committed = cell.innerText; editing = false; cell.innerText = ''; }
  else if (e.key.length === 1) editing = true;
});
</script>`;

test('named keys are pressed, unknown ones refused, and type wakes hidden keydown-only editors', { skip: !fs.existsSync(CHROME) && 'no Chrome' }, async (t) => {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(SHEET);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/`;

  const send = await headlessChrome(t);
  const { targetId } = await send('Target.createTarget', { url });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const TAB = 8;
  const { browserbear } = await startBear(t, ({ op, args }) => {
    if (op === 'tabs') return [{ tabId: TAB, url, title: 'Sheet', active: true, windowId: 1, status: 'complete' }];
    if (op === 'cdp') return send(args.method, args.params, sessionId);
    return true;
  });
  const js = (e) => browserbear('eval', String(TAB), e);

  for (let i = 0; i < 50 && (await js('document.readyState')) !== 'complete'; i++) await new Promise((r) => setTimeout(r, 100));
  await js('field.focus(); field.setSelectionRange(1, 1)');
  await browserbear('key', String(TAB), 'End');
  await browserbear('type', String(TAB), '-', 'Z');
  await browserbear('key', String(TAB), 'Home');
  await browserbear('type', String(TAB), '-', 'A');
  assert.equal(await js('field.value'), 'AabcZ');
  await assert.rejects(browserbear('key', String(TAB), 'Bogus'), /isn't a key/);
  await assert.rejects(browserbear('key', String(TAB), 'Hyper+a'), /isn't a modifier/);
  assert.equal(await js('field.value'), 'AabcZ');
  await browserbear('key', String(TAB), 'Control++');
  assert.deepEqual(JSON.parse(await js('JSON.stringify(combos)')), ['Equal 187']);

  // A real field scrolled up out of its box isn't a hidden stand-in, so type still
  // checks it, and the maxlength cutting "600" short is an error.
  assert.equal(await js('box.scrollTop = 600; short.focus({ preventScroll: true }); short.getBoundingClientRect().bottom < 0'), 'true');
  await assert.rejects(browserbear('type', String(TAB), '-', '600'), /doesn't have "600" in it/);

  await js('cell.focus()');
  assert.match(await browserbear('type', String(TAB), '-', 'hello world'), /real key presses/);
  await browserbear('key', String(TAB), 'Enter');
  assert.equal(await js('committed'), 'hello world');
});
