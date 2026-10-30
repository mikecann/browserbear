import test from 'node:test';
import assert from 'node:assert/strict';
import { RefMap, compact, diff, sameApartFromFocus } from '../service/snapshot.mjs';
import { encodeNative, nativeReader } from '../service/wire.mjs';

// A small made-up page in the shape Accessibility.getFullAXTree returns.
const page = (extra = []) => [
  { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Studio' }, childIds: ['2', '3', '4', '5', '6', ...extra.map((n) => n.nodeId)] },
  { nodeId: '2', parentId: '1', role: { value: 'heading' }, name: { value: 'Channel content' }, properties: [{ name: 'level', value: { value: 1 } }] },
  { nodeId: '3', parentId: '1', role: { value: 'button' }, name: { value: 'Upload videos' }, backendDOMNodeId: 30 },
  { nodeId: '4', parentId: '1', role: { value: 'textbox' }, name: { value: 'Title' }, value: { value: 'My video' }, backendDOMNodeId: 40 },
  { nodeId: '5', parentId: '1', role: { value: 'textbox' }, name: { value: 'API key' }, value: { value: 'sk-live-123' }, backendDOMNodeId: 50 },
  { nodeId: '6', parentId: '1', ignored: true, role: { value: 'generic' }, childIds: ['7'] },
  { nodeId: '7', parentId: '6', role: { value: 'checkbox' }, name: { value: 'Made for kids' }, backendDOMNodeId: 70, properties: [{ name: 'checked', value: { value: 'true' } }] },
  ...extra,
];

test('compact keeps headings and controls, masks secrets, walks through ignored nodes', () => {
  const lines = compact(page(), new RefMap());
  assert.deepEqual(lines, [
    '# Channel content',
    'e1 button "Upload videos"',
    'e2 textbox "Title" = "My video"',
    'e3 textbox "API key" = "••••"',
    'e4 checkbox "Made for kids" [checked]',
  ]);
});

test('file inputs are listed whether or not the tree has them', () => {
  // 70 is in the tree (as its checkbox, here); 99 is hidden, so it isn't.
  const files = new Map([
    [70, { id: 'kids', accept: '' }],
    [99, { id: 'enhance-file-upload', label: '', accept: '.mp3,.wav', multiple: true }],
  ]);
  const lines = compact(page(), new RefMap(), files);
  assert.equal(lines[4], 'e4 file-input "Made for kids" #kids');
  assert.equal(lines.at(-1), 'e5 file-input #enhance-file-upload accept=".mp3,.wav" [multiple, hidden]');
});

test('refs stay on the same node across snapshots', () => {
  const refs = new RefMap();
  compact(page(), refs);
  const dialog = { nodeId: '8', parentId: '1', role: { value: 'dialog' }, name: { value: 'Discard?' }, childIds: ['9'] };
  const ok = { nodeId: '9', parentId: '8', role: { value: 'button' }, name: { value: 'Discard' }, backendDOMNodeId: 90 };
  const lines = compact(page([dialog, ok]), refs);
  assert.ok(lines.includes('e1 button "Upload videos"'));
  assert.ok(lines.includes('e5 button "Discard"'));
  assert.equal(refs.node('e5'), 90);
});

test('diff shows only what changed, and falls back to the full list when that is shorter', () => {
  const rest = Array.from({ length: 10 }, (_, i) => `e${i + 2} link "Page ${i}"`);
  const before = ['# A', 'e1 button "Save"', ...rest];
  assert.equal(diff(null, before).full, true);
  assert.equal(diff(before, before).text, '(no change)');
  const after = ['# A', 'e1 button "Save" [disabled]', ...rest];
  const d = diff(before, after);
  assert.equal(d.full, false);
  assert.match(d.text, /^- e1 button "Save"\n\+ e1 button "Save" \[disabled\]\n\(11 unchanged\)$/);
  const elsewhere = ['# B', 'e9 link "Other"'];
  assert.equal(diff(before, elsewhere).full, true);
});

test('a click that only moved focus counts as changing nothing', () => {
  const before = ['# BTC', 'e1 link "SELL BTC"', 'e2 checkbox "Agree" [checked]'];
  assert.equal(sameApartFromFocus(before, ['# BTC', 'e1 link "SELL BTC" [focused]', 'e2 checkbox "Agree" [checked]']), true);
  assert.equal(sameApartFromFocus(before, ['# BTC', 'e1 link "SELL BTC"', 'e2 checkbox "Agree" [checked, focused]']), true);
  assert.equal(sameApartFromFocus(before, ['# BTC', 'e1 link "SELL BTC"', 'e2 checkbox "Agree"']), false);
  assert.equal(sameApartFromFocus(before, [...before, '## Sell order']), false);
  assert.equal(sameApartFromFocus(null, before), false);
});

test('native framing round-trips, including split chunks', () => {
  const got = [];
  const feed = nativeReader((m) => got.push(m));
  const bytes = Buffer.concat([encodeNative({ a: 1 }), encodeNative({ b: 'ü' })]);
  feed(bytes.subarray(0, 3));
  feed(bytes.subarray(3, 12));
  feed(bytes.subarray(12));
  assert.deepEqual(got, [{ a: 1 }, { b: 'ü' }]);
});
