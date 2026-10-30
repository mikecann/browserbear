import test from 'node:test';
import assert from 'node:assert/strict';
import { INSTALL_COMMAND, setupView } from '../extension/setup-rows.js';

const id = 'iljcldkflmlnmfhbllafbbfnchhoccok';
const states = (view) => Object.fromEntries(view.rows.map((r) => [r.id, r.state]));
const welcomed = { host: 'up', service: true, profile: { name: 'Work', email: 'me@example.com', dir: 'Profile 2' } };

test('nothing installed: the Mac row asks for the install command', () => {
  const view = setupView({ link: { host: 'error', error: 'Specified native messaging host not found.' }, fileAccess: false, extensionId: id });
  assert.deepEqual(states(view), { mac: 'missing', profile: 'missing', files: 'optional' });
  const mac = view.rows[0];
  assert.deepEqual(mac.action, { kind: 'copy', label: 'Copy', text: INSTALL_COMMAND });
  assert.equal(mac.error, 'Specified native messaging host not found.');
  assert.equal(view.allSet, false);
  assert.equal(view.subtitle, '2 things left in this profile.');
});

test('host started, service not yet: checking, not red', () => {
  const view = setupView({ link: { host: 'up', service: false }, fileAccess: true, extensionId: id });
  assert.deepEqual(states(view), { mac: 'checking', profile: 'checking', files: 'done' });
  assert.equal(view.rows[0].detail, 'Starting the service.');
});

test('connected and named: all set, even without file access', () => {
  const view = setupView({ link: welcomed, fileAccess: false, extensionId: id });
  assert.deepEqual(states(view), { mac: 'done', profile: 'done', files: 'optional' });
  assert.equal(view.rows[1].detail, 'Agents call it "Work".');
  assert.equal(view.rows[2].action.url, `chrome://extensions/?id=${id}`);
  assert.equal(view.allSet, true);
  assert.equal(view.title, 'BrowserBear is all set');
});

test('a profile Chrome has no name for is still named by its email', () => {
  const view = setupView({ link: { ...welcomed, profile: { name: null, email: 'me@example.com' } }, fileAccess: true, extensionId: id });
  assert.equal(view.rows[1].detail, 'Agents call it "me@example.com".');
  assert.equal(view.allSet, true);
});

test('not signed in to Chrome: agents cannot pick the profile', () => {
  const view = setupView({ link: { ...welcomed, profile: { name: null, email: null } }, fileAccess: true, extensionId: id });
  assert.equal(view.rows[1].state, 'missing');
  assert.equal(view.rows[1].action.url, 'chrome://settings/people');
  assert.equal(view.subtitle, '1 thing left in this profile.');
});

test('no answer from the background yet counts as checking', () => {
  assert.deepEqual(states(setupView({ link: null, fileAccess: true, extensionId: id })), { mac: 'checking', profile: 'checking', files: 'done' });
});
