// Native messaging host. Chrome starts one of these per profile whose Paws
// extension calls connectNative, and kills it when the port closes. It just
// relays: Chrome frames on stdin/stdout <-> JSON lines on the service socket.
// It never exits on its own while Chrome is connected, because an open port is
// what keeps the extension's service worker awake.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HOME, LOGS, SOCKET, encodeNative, line, lineReader, nativeReader } from '../service/wire.mjs';

fs.mkdirSync(LOGS, { recursive: true, mode: 0o700 });
const logFile = fs.createWriteStream(path.join(LOGS, 'host.log'), { flags: 'a' });
// stdout belongs to Chrome, so nothing may be printed: log to the file only.
const log = (...a) => logFile.write(`${new Date().toISOString()} [${process.pid}] ${a.join(' ')}\n`);

let sock = null;
let hello = null; // resent on every reconnect, so a restarted service knows us
const queue = [];

process.stdin.on(
  'data',
  nativeReader((msg) => {
    if (msg.type === 'hello') hello = msg;
    if (sock) sock.write(line(msg));
    else queue.push(msg);
  }),
);
process.stdin.on('end', () => {
  log('chrome closed the port');
  process.exit(0);
});

const toChrome = (msg) => process.stdout.write(encodeNative(msg));

let started = false;
function startService() {
  if (started) return;
  started = true;
  const service = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'service', 'service.mjs');
  log('starting service', service);
  spawn(process.execPath, [service], { detached: true, stdio: 'ignore', cwd: HOME }).unref();
}

function connect(delay = 0) {
  setTimeout(() => {
    const s = net.createConnection(SOCKET);
    s.on('connect', () => {
      log('connected to service');
      sock = s;
      if (hello) s.write(line(hello));
      for (const m of queue.splice(0)) if (m !== hello) s.write(line(m));
    });
    s.on('data', lineReader(toChrome));
    s.on('error', (e) => {
      if (e.code === 'ENOENT' || e.code === 'ECONNREFUSED') startService();
      else log('socket error', e.message);
    });
    s.on('close', () => {
      if (sock === s) log('service went away');
      sock = null;
      started = false;
      connect(Math.min(5000, delay * 2 || 250));
    });
  }, delay);
}

log('host up', process.argv.slice(2).join(' '));
connect();
