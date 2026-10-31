// Starts the real host (which starts the real service) with the test playing
// the extension: onOp answers each { id, op, args } the host passes on.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { encodeNative, nativeReader } from '../service/wire.mjs';

export const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = promisify(execFile);

export async function startBear(t, onOp, extraEnv = {}) {
  // Short path: Unix socket paths are capped at 104 bytes on macOS.
  const home = fs.mkdtempSync(path.join('/tmp', 'browserbear-'));
  const localState = path.join(home, 'Local State');
  fs.writeFileSync(localState, JSON.stringify({ profile: { info_cache: { 'Profile 2': { name: 'Work', user_name: 'me@example.com' } } } }));
  // No real Threadbear: tests that want one pass a fake tb and a thread id.
  const env = { ...process.env, BROWSERBEAR_HOME: home, BROWSERBEAR_CHROME_LOCAL_STATE: localState, BROWSERBEAR_TB: '', THREADBEAR_THREAD_ID: '', ...extraEnv };

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

export const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// A real headless Chrome, and a send(method, params, sessionId) for its CDP.
export async function headlessChrome(t) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'browserbear-chrome-'));
  const chrome = spawn(CHROME, ['--headless', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  t.after(async () => {
    // Chrome keeps writing to its profile until it has really gone.
    const gone = new Promise((r) => chrome.once('exit', r));
    chrome.kill();
    await gone;
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  });
  const portFile = path.join(profile, 'DevToolsActivePort');
  // Chrome writes the port, then the path, so wait for both.
  const read = () => (fs.existsSync(portFile) ? fs.readFileSync(portFile, 'utf8').split('\n') : []);
  for (let i = 0; i < 100 && !read()[1]; i++) await new Promise((r) => setTimeout(r, 100));
  const [port, wsPath] = read();
  const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  t.after(() => ws.close());
  let next = 1;
  const waiting = new Map();
  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    const w = waiting.get(msg.id);
    if (!w) return;
    waiting.delete(msg.id);
    msg.error ? w.reject(new Error(msg.error.message)) : w.resolve(msg.result);
  };
  return (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = next++;
      waiting.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
}

const CACHE = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
const build = fs.existsSync(CACHE) && fs.readdirSync(CACHE).filter((d) => /^chromium-\d+$/.test(d)).sort().pop();
const cft = build && path.join(CACHE, build, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
// Playwright's Chromium, or nothing: branded Chrome won't load unpacked
// extensions from the command line.
export const CFT = cft && fs.existsSync(cft) ? cft : null;
const BEAR_ID = 'iljcldkflmlnmfhbllafbbfnchhoccok'; // from the manifest's key

// The real extension in Chrome for Testing, and an inWorker(expression) that
// runs in its service worker, resolving to its value or rejecting with its error.
export async function extensionInChrome(t, otherExtensions = []) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'browserbear-cft-'));
  const exts = [path.join(root, 'extension'), ...otherExtensions].join(',');
  const chrome = spawn(CFT, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', `--disable-extensions-except=${exts}`, `--load-extension=${exts}`, 'about:blank'], { stdio: 'ignore' });
  t.after(async () => {
    const gone = new Promise((r) => chrome.once('exit', r));
    chrome.kill();
    await gone;
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  });
  const portFile = path.join(profile, 'DevToolsActivePort');
  const read = () => (fs.existsSync(portFile) ? fs.readFileSync(portFile, 'utf8').split('\n') : []);
  // Chrome for Testing can take a while on its first start.
  for (let i = 0; i < 400 && !read()[1]; i++) await new Promise((r) => setTimeout(r, 100));
  const [port, wsPath] = read();
  const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  t.after(() => ws.close());
  let next = 1;
  const waiting = new Map();
  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    waiting.get(msg.id)?.(msg);
    waiting.delete(msg.id);
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve) => {
      const id = next++;
      waiting.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });

  let worker;
  for (let i = 0; i < 50 && !worker; i++) {
    const { result } = await send('Target.getTargets');
    worker = result.targetInfos.find((x) => x.type === 'service_worker' && x.url.includes(BEAR_ID));
    if (!worker) await new Promise((r) => setTimeout(r, 200));
  }
  if (!worker) throw new Error("BrowserBear's service worker never started");
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId: worker.targetId, flatten: true });
  return async (expression) => {
    const { result } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
}
