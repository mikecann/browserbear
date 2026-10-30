// Starts the real host (which starts the real service) with the test playing
// the extension: onOp answers each { id, op, args } the host passes on.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { encodeNative, nativeReader } from '../service/wire.mjs';

export const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = promisify(execFile);

export async function startBear(t, onOp) {
  // Short path: Unix socket paths are capped at 104 bytes on macOS.
  const home = fs.mkdtempSync(path.join('/tmp', 'browserbear-'));
  const localState = path.join(home, 'Local State');
  fs.writeFileSync(localState, JSON.stringify({ profile: { info_cache: { 'Profile 2': { name: 'Work', user_name: 'me@example.com' } } } }));
  const env = { ...process.env, BROWSERBEAR_HOME: home, BROWSERBEAR_CHROME_LOCAL_STATE: localState };

  const host = spawn(process.execPath, [path.join(root, 'host', 'browserbear-host.mjs'), 'chrome-extension://x/'], { env });
  const notices = []; // { type } messages from the host and service, for the setup page
  const reply = (msg) => host.stdin.write(encodeNative(msg));
  host.stdout.on(
    'data',
    nativeReader(async (msg) => {
      if (msg.type) return notices.push(msg);
      try {
        reply({ id: msg.id, ok: true, result: await onOp(msg) });
      } catch (e) {
        reply({ id: msg.id, ok: false, error: e.message });
      }
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
  return { browserbear, notices, profiles, home };
}
