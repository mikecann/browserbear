// fill signs in from 1Password in the agent's own Chrome. What it types comes
// from op and goes into the page; the agent only hears which login and fields.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startBear, root } from './harness.mjs';
import { allowedFor, loginMatches, pickLogin, sameSite } from '../service/onepassword.mjs';

const OP = path.join(root, 'test', 'fakes', 'op.mjs');

test('which sites a login goes to', () => {
  assert.ok(sameSite('accounts.google.com', 'google.com'));
  // Never up to a parent, nor to a stranger's subdomain on shared hosting.
  assert.ok(!sameSite('google.com', 'accounts.google.com'));
  assert.ok(!sameSite('notgoogle.com', 'google.com'));
  assert.ok(!sameSite('evil.github.io', 'github.io'));
  assert.ok(sameSite('mike.github.io', 'mike.github.io'));
  const login = { sites: [{ host: 'example.com', port: '' }] };
  assert.ok(loginMatches(login, 'https://example.com/login'));
  assert.ok(loginMatches(login, 'https://accounts.example.com/login'));
  assert.ok(!loginMatches(login, 'http://example.com/login'));
  assert.ok(!loginMatches(login, 'https://example.com:8443/login'));
  // Saved without a scheme, the way 1Password often keeps them.
  assert.ok(loginMatches({ sites: [{ host: 'x.com', port: '' }] }, 'https://x.com/i/flow/login'));
  assert.deepEqual(allowedFor({ sites: [{ host: 'mike.github.io', port: '' }, { host: 'example.com', port: '' }] }), [
    { host: 'mike.github.io', sub: false, port: '' },
    { host: 'example.com', sub: true, port: '' },
  ]);
  const logins = [{ id: 'a', title: 'Work' }, { id: 'b', title: 'Home' }];
  assert.equal(pickLogin(logins, 'home', 'https://x.test').id, 'b');
  assert.throws(() => pickLogin(logins, undefined, 'https://x.test'), /2 logins for x\.test; say which with --item/);
  assert.throws(() => pickLogin([], undefined, 'https://x.test'), /no login saved for x\.test.*handoff/);
});

// A fake agent Chrome page: which fields it has, where the tab is when fill
// focuses a field, and what got typed.
function fakePage() {
  const page = { fields: { user: true, password: true, otp: false }, split: false, at: 'https://example.com/login', loader: 'L1', typed: [] };
  page.onOp = ({ op, args }) => {
    if (op === 'tabs') return [{ tabId: 7, url: 'https://example.com/login', title: 'Sign in', active: true, agent: true, bear: true }];
    if (op !== 'cdp') return {};
    const { method, params = {} } = args;
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'F', url: 'https://example.com/login', loaderId: page.loader } } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 9 };
    if (method === 'Runtime.evaluate' && params.expression === 'document') return { result: { objectId: 'doc' } };
    if (method === 'Runtime.evaluate') return { result: { type: 'string', value: 'Sign in' } };
    if (method === 'Runtime.callFunctionOn' && params.objectId === 'doc') return { result: { objectId: 'found' } };
    if (method === 'Runtime.getProperties') {
      const node = (name) => ({ name, value: page.fields[name] ? { subtype: 'node', objectId: `el-${name}` } : { subtype: 'null' } });
      return { result: [node('user'), node('password'), node('otp'), { name: 'splitCode', value: { value: page.split } }] };
    }
    if (method === 'Runtime.callFunctionOn' && params.arguments) {
      // The page side of PUT_FIELD: checks where the tab is, then types.
      const [value, allowed] = params.arguments.map((a) => a.value);
      const u = new URL(page.at);
      const host = u.hostname.replace(/^www\./, '');
      if (u.protocol !== 'https:' || !allowed.some((a) => host === a.host || (a.sub && host.endsWith(`.${a.host}`)))) return { result: { value: 'site' } };
      page.typed.push(value);
      return { result: { value: 'ok' } };
    }
    if (method === 'DOM.describeNode') return { node: { backendNodeId: 40 } };
    if (method === 'Accessibility.getFullAXTree') {
      return { nodes: [{ nodeId: '1', role: { value: 'RootWebArea' }, childIds: ['2'] }, { nodeId: '2', parentId: '1', role: { value: 'textbox' }, name: { value: 'Email' }, value: { value: 'user-bbb@example.com' }, backendDOMNodeId: 40 }] };
    }
    return {};
  };
  return page;
}

test("fill types the login into the agent's page and never prints it", async (t) => {
  const page = fakePage();
  const { browserbear } = await startBear(t, page.onOp, { BROWSERBEAR_OP: OP }, { instance: 'agent-chrome' });
  const fails = (p, re) => assert.rejects(p, (e) => (assert.match(e.stderr, re), true));

  // Two logins for the site: it asks which, by name.
  await fails(browserbear('fill', '7'), /2 logins for example\.com; say which with --item.*"Example work" \(aaa/s);
  const out = await browserbear('fill', '7', '--item', 'Example personal');
  assert.deepEqual(page.typed, ['user-bbb@example.com', 'pw-bbb-secret']);
  assert.match(out, /filled the username, password from 1Password \("Example personal"\) in tab 7/);
  assert.doesNotMatch(out, /pw-bbb|user-bbb/);

  // The values can't be read back on that page: no eval or cdp, and snapshots hide them.
  await fails(browserbear('eval', '7', 'document.title'), /eval is off in tab 7 until it leaves the page fill signed in on/);
  await fails(browserbear('cdp', '7', 'Runtime.evaluate', '{}'), /cdp is off in tab 7/);
  await fails(browserbear('secret', '7', '--css', 'input[type=password]', '--to', '/tmp/bb-never-written'), /secret is off in tab 7/);
  const snap = await browserbear('snap', '7');
  assert.match(snap, /textbox "Email" = "••••"/);
  assert.doesNotMatch(snap, /user-bbb/);
  // A new page: eval works again.
  page.loader = 'L2';
  await browserbear('eval', '7', 'document.title');

  // The code step of a two-step sign-in.
  page.typed.length = 0;
  page.fields = { user: false, password: false, otp: true };
  assert.match(await browserbear('fill', '7', '--item', 'aaa'), /filled the one-time code/);
  assert.deepEqual(page.typed, ['123456']);
  await fails(browserbear('fill', '7', '--item', 'bbb'), /wants a one-time code, but "Example personal" in 1Password has none/);
  page.split = true;
  await fails(browserbear('fill', '7', '--item', 'aaa'), /split across several boxes/);
});

test('fill stops if the tab went to another site while 1Password was asking', async (t) => {
  const page = fakePage();
  page.at = 'https://evil.test/login';
  const { browserbear } = await startBear(t, page.onOp, { BROWSERBEAR_OP: OP }, { instance: 'agent-chrome' });
  await assert.rejects(browserbear('fill', '7', '--item', 'aaa'), (e) => (assert.match(e.stderr, /fill stopped: the tab is no longer on a site "Example work" is saved for/), true));
  assert.deepEqual(page.typed, []);
});

test("fill won't sign in in the user's own profiles", async (t) => {
  const { browserbear } = await startBear(t, ({ op }) => (op === 'tabs' ? [{ tabId: 7, url: 'https://example.com/', title: 'X', active: true, agent: true, bear: true }] : {}), { BROWSERBEAR_OP: OP });
  await assert.rejects(browserbear('fill', '7'), (e) => (assert.match(e.stderr, /fill only signs in in the agent's own Chrome/), true));
});
