// eToro's withdrawal form (19 Nov). Its SWIFT box, masked "XXXX AU XXXXX", put
// its own "AU" in front of inserted "NATAAU3303M" and held "AUNATAAU3303M",
// and type said it worked since the text was in there. Keys one at a time went
// in right. And "Withdraw Funds" sat in a collapsed side menu that hovering
// didn't open, so click --text failed, with --script too, though a script
// click on its link worked. Real headless Chrome.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { CHROME, headlessChrome, startBear } from './harness.mjs';

const PAGE = `<!doctype html><title>Withdraw</title>
<nav id="side" style="width: 60px; height: 300px; background: #eee">
  <ul class="menu-list" style="display: none">
    <li id="sidenav-withdrawal"><a automation-id="sidenav-menu-withdraw"><span class="text">Withdraw Funds</span></a></li>
  </ul>
</nav>
<label>SwiftCode <input id="swift" name="SwiftCode" placeholder="XXXX AU XXXXX"></label>
<label>Note <input id="note" value="ref "></label>
<label>Amount <input id="amount"></label>
<label>Count <input id="count" type="number" value="123"></label>
<label>Debit <input id="debit"></label>
<label>Sort <input id="sort" maxlength="4"></label>
<label>Next <input id="next"></label>
<script>
window.log = [];
// Handled once on the menu, by what was clicked, as delegated handlers are.
side.addEventListener('click', (e) => { if (e.target.closest('[automation-id=sidenav-menu-withdraw]')) log.push('withdraw'); });
// Takes letters and digits, groups them as the mask shows, and mangles text
// that comes in more than one character at a time.
swift.addEventListener('input', (e) => {
  const raw = swift.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (e.data && e.data.length > 1) return void (swift.value = 'AU' + raw);
  swift.value = [raw.slice(0, 4), raw.slice(4, 6), raw.slice(6)].filter(Boolean).join(' ');
});
// Drops what it can't show, a minus sign included.
amount.addEventListener('input', () => { amount.value = amount.value.replace(/[^0-9.]/g, ''); });
// Makes every amount a debit.
debit.addEventListener('input', () => { if (!debit.value.startsWith('-')) debit.value = '-' + debit.value; });
// Full, it moves on to the next field.
sort.addEventListener('input', () => { if (sort.value.length === 4) next.focus(); });
// A field that adds its own letters to whatever it's given, keys or not.
note.addEventListener('input', () => { if (!note.value.endsWith('!')) note.value += 'X'; });
</script>`;

test('type fails or retries when the page changes the text; --script clicks a hidden menu item', { skip: !fs.existsSync(CHROME) && 'no Chrome' }, async (t) => {
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
  const page = (method, params) => send(method, params, sessionId);
  const value = async (expression) => (await page('Runtime.evaluate', { expression, returnByValue: true })).result.value;
  for (let i = 0; i < 50 && (await value('document.readyState')) !== 'complete'; i++) await new Promise((r) => setTimeout(r, 100));

  const { browserbear } = await startBear(t, async ({ op, args }) => {
    if (op === 'tabs') return [{ tabId: 1, url, title: 'Withdraw', active: true, windowId: 1, status: 'complete', agent: true }];
    if (op === 'cdp') return page(args.method, args.params);
    return true;
  });
  const fails = (...a) => browserbear(...a).then((out) => assert.fail(`expected an error, got: ${out}`), (e) => e.stderr || e.message);
  const snap = await browserbear('snap', '1');
  const ref = (name) => snap.match(new RegExp(`(e\\d+) \\w+ "${name}`))[1];

  // Mangled: cleared and typed again as keys, which the mask groups.
  assert.match(await browserbear('type', '1', ref('SwiftCode'), 'NATAAU3303M'), /changed the inserted text into "AUNATAAU3303M", so it was cleared and typed again as real key presses/);
  assert.equal(await value('swift.value'), 'NATA AU 3303M');

  // --replace does the same.
  await browserbear('type', '1', ref('SwiftCode'), 'ANZBAU3M', '--replace').catch((e) => assert.fail(e.stderr));
  assert.equal(await value('swift.value'), 'ANZB AU 3M');

  // Held something before, and gains letters of the page's own: an error, not a success.
  assert.match(await fails('type', '1', ref('Note'), 'abc'), /holds "[^"]*X", which isn.t what it held plus "abc": the page added to it/);

  // Typed over the same text, selected: still checked, and put right.
  await value('swift.value = "NATAAU3303M"; swift.select()');
  assert.match(await browserbear('type', '1', ref('SwiftCode'), 'NATAAU3303M'), /cleared and typed again as real key presses/);
  assert.equal(await value('swift.value'), 'NATA AU 3303M');

  // A minus sign lost is a different amount, not formatting.
  assert.match(await fails('type', '1', ref('Amount'), '-100', '--replace'), /--replace didn't work[\s\S]*holds "100"/);
  assert.match(await fails('type', '1', ref('Amount'), '-5'), /holds "1005", which isn.t what it held plus "-5"/);

  // A number field can't say what's selected, so typing over all of it is fine.
  await value('count.focus(); count.select()');
  await browserbear('type', '1', ref('Count'), '42').catch((e) => assert.fail(e.stderr));
  assert.equal(await value('count.value'), '42');
  // ...and typing the same over it doesn't put it in twice.
  await value('count.focus(); count.select()');
  await browserbear('type', '1', ref('Count'), '42').catch((e) => assert.fail(e.stderr));
  assert.equal(await value('count.value'), '42');

  // A sign the page adds isn't formatting either.
  assert.match(await fails('type', '1', ref('Debit'), '100', '--replace'), /--replace went wrong.*into "-100"/);

  // Cut short and moved on: the keys typed again stop where focus leaves,
  // rather than running on into the next field.
  assert.match(await fails('type', '1', ref('Sort'), '12345678'), /focus left the field/);
  assert.equal(await value('next.value'), '');

  // Hidden in a collapsed menu: a real click says --script would do it...
  assert.match(await fails('click', '1', '--text', 'Withdraw Funds'), /didn't show it[\s\S]*add --script to click it by script where it is/);
  assert.deepEqual(await value('log'), []);
  // ...and --script clicks the link it's in, without showing it.
  assert.match(await browserbear('click', '1', '--text', 'Withdraw Funds', '--script'), /hidden, so it was clicked by script where it is, without showing it/);
  assert.deepEqual(await value('log'), ['withdraw']);
});
