// Controls with no role, as Zoho Campaigns builds them (17 Nov): a campaign-type
// card that's a <div> whose "Create New" button only shows on hover, a sender
// dropdown that's a <p> opening a list of <li><a> (handled once on the
// document, jQuery style), icon-only <a title=Edit> links with no href, and a
// confirm dialog whose "Go Ahead" ignores clicks that aren't real. snap listed
// none of them and click took only refs, so an agent fell back to eval'd mouse
// events, some of which did nothing at all. Real headless Chrome.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { CHROME, headlessChrome, startBear } from './harness.mjs';

const PAGE = `<!doctype html><title>Campaigns</title>
<style>
  .zcadvcmpbox { cursor: pointer; border: 1px solid #ccc; width: 260px; padding: 10px; margin: 8px; }
  .zcadvcmpbox .btn { display: none; }
  .zcadvcmpbox:hover .btn { display: inline-block; }
  .sel p, .sel a, .act { cursor: pointer; }
  .overlay { position: fixed; inset: 0; background: rgba(0,0,0,.3); }
  .confirm { position: fixed; top: 40px; left: 40px; background: white; padding: 20px; }
  .icon { display: inline-block; width: 16px; height: 16px; background: #888; }
</style>
<h1>Create campaign</h1>
<div class="zcadvcmpbox" id="regular"><h4>Regular email</h4><p>Send a one-off email</p><button class="btn pri">Create New</button></div>
<div class="zcadvcmpbox" id="ab"><h4>A/B testing</h4><p>Try two subject lines</p><button class="btn pri">Create New</button></div>
<div class="sel"><p id="from">Choose a sender</p><ul id="list" hidden><li><a>mike@example.com</a></li><li><a>sales@example.com</a></li></ul></div>
<table>
  <tr><td>Spring offer</td><td><a title="Edit" class="act"><i class="icon"></i></a> <a title="Delete" class="act"><i class="icon"></i></a></td></tr>
  <tr><td>Summer offer</td><td><a title="Edit" class="act"><i class="icon"></i></a> <a title="Delete" class="act"><i class="icon"></i></a></td></tr>
</table>
<span class="act" id="behind">Go Ahead</span>
<button id="icon" aria-label="Archive"><i class="icon"></i><span hidden>Archive</span></button>
<div id="host"></div>
<button id="light">Share</button>
<button id="split">Close<br>account</button>
<button id="pinned">Pin</button><button id="pinned2">Pin</button>
<div id="tip" style="position: absolute; padding: 20px; background: #eee">tip</div>
<div style="height: 3000px"></div>
<span class="act" id="far">Go Ahead</span>
<script>
window.log = [];
const say = (what, e) => log.push(what + (e.isTrusted ? '' : ' (untrusted)'));
for (const card of document.querySelectorAll('.zcadvcmpbox')) {
  card.querySelector('.btn').addEventListener('click', (e) => { e.stopPropagation(); say('create ' + card.id, e); });
}
// One listener for the lot, as jQuery's delegated handlers are.
document.addEventListener('click', (e) => {
  if (e.target.closest('#from')) { list.hidden = !list.hidden; return say('open senders', e); }
  const a = e.target.closest('#list a');
  if (a) { from.textContent = a.textContent; list.hidden = true; return say('sender ' + a.textContent, e); }
  const act = e.target.closest('a[title]');
  if (act) {
    const row = act.closest('tr').cells[0].textContent;
    if (act.title === 'Edit') return say('edit ' + row, e);
    const box = document.createElement('div');
    box.innerHTML = '<div class="overlay"></div><div class="confirm"><p>Delete ' + row + '?</p><span class="act" id="go">Go Ahead</span></div>';
    document.body.append(box);
    // Only a real press and release counts, as the agent saw on Zoho's.
    let down = false;
    box.querySelector('#go').addEventListener('mousedown', (e) => { down = e.isTrusted; });
    box.querySelector('#go').addEventListener('mouseup', (e) => { if (down && e.isTrusted) { say('deleted ' + row, e); box.remove(); } });
    return say('asked to delete ' + row, e);
  }
  if (e.target.id === 'behind') say('behind the dialog', e);
  if (e.target.id === 'split') say('close account', e);
  if (e.target.id === 'far') say('far below the dialog', e);
  if (e.target.id === 'icon' || e.target.closest?.('#icon')) say('archive', e);
});
// One "Share" in a shadow root, one outside it: two matches, not a guess.
const shadow = host.attachShadow({ mode: 'open' });
shadow.innerHTML = '<button>Share</button>';
shadow.querySelector('button').addEventListener('click', (e) => say('shadow share', e));
</script>`;

test('click finds controls with no role by text or selector, hovering first', { skip: !fs.existsSync(CHROME) && 'no Chrome' }, async (t) => {
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
  const TAB = '7';
  const { browserbear } = await startBear(t, ({ op, args }) => {
    if (op === 'tabs') return [{ tabId: 7, url, title: 'Campaigns', active: true, windowId: 1, status: 'complete', agent: true }];
    if (op === 'cdp') return send(args.method, args.params, sessionId);
    return true;
  });
  for (let i = 0; i < 50 && (await browserbear('eval', TAB, 'document.readyState')) !== 'complete'; i++) await new Promise((r) => setTimeout(r, 100));
  const log = async () => JSON.parse(await browserbear('eval', TAB, 'JSON.stringify(log)'));
  const fails = (...a) => browserbear(...a).then(() => assert.fail('should have failed'), (e) => e.stderr);

  // snap lists them, by their text or their title, and not the cards' hidden buttons.
  const snap = await browserbear('snap', TAB);
  assert.match(snap, /e\d+ clickable "Regular email Send a one-off email"/);
  assert.match(snap, /e\d+ clickable "Choose a sender"/);
  assert.equal(snap.match(/clickable "Edit"/g)?.length, 2);
  assert.doesNotMatch(snap, /Create New/);
  // Nor the page's body or the table around the icons.
  assert.doesNotMatch(snap, /clickable "Create campaign/);

  // A button that only shows while its card is hovered, found by its text.
  // Two cards have one, so that's an error until --nth says which.
  assert.match(await fails('click', TAB, '--text', 'Create New'), /matches 2 hidden elements[\s\S]*1\. button\.btn "Create New" in "Regular email[\s\S]*2\. button\.btn "Create New" in "A\/B testing/);
  const created = await browserbear('click', TAB, '--text', 'Create New', '--nth', '1');
  assert.match(created, /\(e\d+ is button\.btn "Create New" in "Regular email[^"]*"; it showed once the pointer was over div#regular/);
  assert.deepEqual(await log(), ['create regular']);

  // The dropdown by its ref from snap, then an option by its text.
  const from = /(e\d+) clickable "Choose a sender"/.exec(snap)[1];
  await browserbear('click', TAB, from);
  await browserbear('click', TAB, '--text', 'sales@example.com');
  assert.equal(await browserbear('eval', TAB, 'from.textContent'), 'sales@example.com');
  assert.deepEqual((await log()).slice(1), ['open senders', 'sender sales@example.com']);

  // Icon links by selector: one per row, so the error says which row each is in.
  assert.match(await fails('click', TAB, '--css', 'a[title=Delete]'), /matches 2[\s\S]*1\. a\.act "Delete" in "Spring offer[\s\S]*2\. a\.act "Delete" in "Summer offer/);
  // A selector where the ref goes works too.
  await browserbear('click', TAB, 'a[title=Edit]', '--nth', '2');
  // --nth with no number is an error, not the first.
  assert.match(await fails('click', TAB, '--css', 'a[title=Delete]', '--nth'), /--nth takes a number from 1/);
  await browserbear('click', TAB, '--css', 'a[title=Delete]', '--nth', '2');
  // Three say "Go Ahead": the dialog covers one, and the one far down the
  // page is under the dialog too, so it's the dialog's.
  await browserbear('click', TAB, '--text', 'Go Ahead');
  assert.deepEqual((await log()).slice(3), ['edit Summer offer', 'asked to delete Summer offer', 'deleted Summer offer']);

  // An icon button whose hidden tooltip says the same: the button, not the tooltip.
  await browserbear('click', TAB, '--text', 'Archive');
  // A match in a shadow root counts as on top, so two "Share"s are ambiguous.
  assert.match(await fails('click', TAB, '--text', 'Share'), /matches 2/);
  await browserbear('click', TAB, '--text', 'Share', '--nth', '2');
  assert.deepEqual((await log()).slice(6), ['archive', 'shadow share']);

  // Text broken by a <br> still matches.
  await browserbear('click', TAB, '--text', 'Close account');
  assert.equal((await log()).at(-1), 'close account');
  // A tooltip over one of two "Pin"s isn't a dialog: still two, not the other one.
  await browserbear('eval', TAB, "const r = pinned.getBoundingClientRect(); tip.style.left = (r.left - 10 + scrollX) + 'px'; tip.style.top = (r.top - 10 + scrollY) + 'px'; 1");
  assert.match(await fails('click', TAB, '--text', 'Pin'), /matches 2/);
  // Nor is a narrow panel far taller than the window.
  await browserbear('eval', TAB, "tip.style.height = '20000px'; tip.style.width = '60px'; 1");
  assert.match(await fails('click', TAB, '--text', 'Pin'), /matches 2/);

  // A real click far down a scrolled page: the check for what's on top used
  // to look a scroll's height above it, and fell back to a script click.
  await browserbear('click', TAB, '--css', '#far');
  assert.equal((await log()).at(-1), 'far below the dialog');

  // hover on its own shows a hover-only button for snap to list.
  const hovered = await browserbear('hover', TAB, '--css', '#ab');
  assert.match(hovered, /e\d+ button "Create New"/);

  assert.match(await fails('click', TAB, '--text', 'No such thing'), /nothing in the page matches the text "No such thing"/);
  assert.match(await fails('click', TAB, '--css', 'a[title='), /is not a CSS selector that works/);
});
