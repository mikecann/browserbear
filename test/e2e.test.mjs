import test from 'node:test';
import assert from 'node:assert/strict';
import { startBear } from './harness.mjs';

test('CLI -> service -> host -> fake extension and back', async (t) => {
  const cdpCalls = [];
  const handedOff = [];
  let topNode = 99; // what DOM.getNodeForLocation says is at the click point
  const { browserbear, notices, profiles } = await startBear(t, ({ op, args }) => {
    if (op === 'tabs') {
      return [
        { tabId: 7, url: 'https://studio.youtube.com/', title: 'Studio', active: true },
        // An agent's tab, in BrowserBear's window: an id the handoff tests look for.
        { tabId: 8, url: 'https://login.qantas.com/signin', title: 'Log in', active: true, agent: true },
      ];
    }
    // Opening the bookings page lands on the sign-in page (tab 8).
    if (op === 'open') return { tabId: 8, url: 'https://login.qantas.com/signin', title: 'Log in', active: true };
    if (op === 'handoff') {
      handedOff.push(args.tabId);
      return { tabId: args.tabId, url: 'https://login.qantas.com/signin', title: 'Log in' };
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
        // One hidden file input, which isn't in the tree above.
        'DOM.getDocument': { root: { nodeId: 1 } },
        'DOM.querySelectorAll': { nodeIds: [5] },
        'DOM.describeNode': { node: { backendNodeId: 77, attributes: ['id', 'video-file', 'accept', 'video/*', 'style', 'display:none'] } },
        'DOM.getContentQuads': { quads: [[0, 0, 10, 0, 10, 10, 0, 10]] },
        'DOM.getNodeForLocation': { backendNodeId: topNode },
        'DOM.resolveNode': { object: { objectId: `obj-${args.params?.backendNodeId}` } },
        // Only asked when something else is on top: it names the covering element.
        'Runtime.callFunctionOn': { result: { value: 'div#overlay' } },
      };
      return results[args.method] || {};
    }
    throw new Error(`unexpected op ${op}`);
  });

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
  assert.match(snap, /e2 file-input #video-file accept="video\/\*" \[hidden\]$/m);

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
