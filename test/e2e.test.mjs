// The whole chain without Chrome: this test plays the extension, talking
// native messaging to the real host, which starts the real service, which the
// real CLI talks to.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { encodeNative, nativeReader } from '../service/wire.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = promisify(execFile);

test('CLI -> service -> host -> fake extension and back', async (t) => {
  // Short path: Unix socket paths are capped at 104 bytes on macOS.
  const home = fs.mkdtempSync(path.join('/tmp', 'browserbear-'));
  const localState = path.join(home, 'Local State');
  fs.writeFileSync(localState, JSON.stringify({ profile: { info_cache: { 'Profile 2': { name: 'Work', user_name: 'me@example.com' } } } }));
  const env = { ...process.env, BROWSERBEAR_HOME: home, BROWSERBEAR_CHROME_LOCAL_STATE: localState };

  const host = spawn(process.execPath, [path.join(root, 'host', 'browserbear-host.mjs'), 'chrome-extension://x/'], { env });
  const cdpCalls = [];
  const notices = []; // { type } messages from the host and service, for the setup page
  const handedOff = [];
  let topNode = 99; // what DOM.getNodeForLocation says is at the click point
  const reply = (msg) => host.stdin.write(encodeNative(msg));
  host.stdout.on(
    'data',
    nativeReader((msg) => {
      if (msg.type) return notices.push(msg);
      const { id, op, args } = msg;
      if (op === 'tabs') {
        return reply({
          id,
          ok: true,
          result: [
            { tabId: 7, url: 'https://studio.youtube.com/', title: 'Studio', active: true },
            // An agent's tab, in BrowserBear's window: an id the handoff tests look for.
            { tabId: 8, url: 'https://login.qantas.com/signin', title: 'Log in', active: true, agent: true },
          ],
        });
      }
      // Opening the bookings page lands on the sign-in page (tab 8).
      if (op === 'open') return reply({ id, ok: true, result: { tabId: 8, url: 'https://login.qantas.com/signin', title: 'Log in', active: true } });
      if (op === 'handoff') {
        handedOff.push(args.tabId);
        return reply({ id, ok: true, result: { tabId: args.tabId, url: 'https://login.qantas.com/signin', title: 'Log in' } });
      }
      if (op === 'cdp') {
        cdpCalls.push(args.method);
        const results = {
          'Accessibility.getFullAXTree': {
            nodes: [
              { nodeId: '1', role: { value: 'RootWebArea' }, childIds: ['2'] },
              { nodeId: '2', parentId: '1', role: { value: 'button' }, name: { value: 'Upload' }, backendDOMNodeId: 99 },
            ],
          },
          'DOM.getContentQuads': { quads: [[0, 0, 10, 0, 10, 10, 0, 10]] },
          'DOM.getNodeForLocation': { backendNodeId: topNode },
          'DOM.resolveNode': { object: { objectId: `obj-${args.params?.backendNodeId}` } },
          // Only asked when something else is on top: it names the covering element.
          'Runtime.callFunctionOn': { result: { value: 'div#overlay' } },
        };
        return reply({ id, ok: true, result: results[args.method] || {} });
      }
      reply({ id, ok: false, error: `unexpected op ${op}` });
    }),
  );
  reply({ type: 'hello', instance: 'inst-1', email: 'me@example.com', version: 'test' });

  const browserbear = (...a) => run(process.execPath, [path.join(root, 'cli.mjs'), ...a], { env }).then((r) => r.stdout.trim());
  t.after(async () => {
    const status = JSON.parse(await browserbear('status').catch(() => '{}'));
    host.kill();
    if (status.pid) process.kill(status.pid);
    fs.rmSync(home, { recursive: true, force: true });
  });

  // The host starts the service; wait for the profile to show up.
  let profiles = '';
  for (let i = 0; i < 40 && !profiles.includes('●'); i++) {
    await new Promise((r) => setTimeout(r, 150));
    profiles = await browserbear('profiles').catch(() => '');
  }
  assert.match(profiles, /● Work \(me@example\.com, Profile 2\)/);
  // The setup page hears that the host started, reached the service, and
  // what agents call this profile.
  assert.deepEqual(notices, [
    { type: 'service', up: false },
    { type: 'service', up: true },
    { type: 'welcome', name: 'Work', email: 'me@example.com', dir: 'Profile 2' },
  ]);

  assert.match(await browserbear('tabs', '--profile', 'Work'), /7\* Studio <https:\/\/studio\.youtube\.com\/>/);

  const snap = await browserbear('claim', 'studio');
  assert.match(snap, /tab 7: Studio/);
  assert.match(snap, /e1 button "Upload"/);

  const after = await browserbear('click', '7', 'e1');
  assert.match(after, /\(no change\)/);
  assert.deepEqual(
    cdpCalls.filter((m) => m.startsWith('Input.')),
    ['Input.dispatchMouseEvent', 'Input.dispatchMouseEvent'],
  );

  // Something covering the button: no real click, a script click instead.
  topNode = 55;
  cdpCalls.length = 0;
  assert.match(await browserbear('click', '7', 'e1'), /div#overlay was on top of it, so that was a script click/);
  assert.equal(cdpCalls.filter((m) => m.startsWith('Input.')).length, 0);

  // A link to the page an agent's tab is on gets that tab, not a new one;
  // the same site isn't enough, and the user's own tabs (7) are never
  // matched by URL.
  assert.match(await browserbear('handoff', 'https://login.qantas.com/signin#top'), /tab 8 is in front of the user/);
  await assert.rejects(browserbear('handoff', 'https://login.qantas.com/help'), /no agent tab is open on/);
  await assert.rejects(browserbear('handoff', 'https://studio.youtube.com/'), /no agent tab is open on/);
  assert.match(await browserbear('handoff', '7'), /tab 7 is in front of the user/);
  // ...and where the agent sent it, though it redirected to sign in.
  const bookings = 'https://www.qantas.com/au/en/frequent-flyer/my-account/bookings.html';
  assert.match(await browserbear('open', bookings, '--profile', 'Work'), /opened tab 8 in Work/);
  assert.match(await browserbear('handoff', bookings), /tab 8 is in front of the user/);
  assert.deepEqual(handedOff, [8, 7, 8]);

  await assert.rejects(browserbear('click', '7', 'e42'), /unknown ref e42/);
  await assert.rejects(browserbear('tabs', '--profile', 'Personal'), /no connected profile matches "Personal"/);
});
