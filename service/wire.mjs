// The two wire formats Paws speaks, and where its files live.
//  - Chrome native messaging: 4-byte little-endian length, then JSON.
//  - Everything on the local socket: one JSON object per line.
import os from 'node:os';
import path from 'node:path';

export const HOME = process.env.PAWS_HOME || path.join(os.homedir(), 'Library', 'Application Support', 'Paws');
export const SOCKET = path.join(HOME, 'paws.sock');
export const LOGS = path.join(HOME, 'logs');
export const OUT = path.join(HOME, 'out'); // screenshots and page dumps

export function encodeNative(msg) {
  const body = Buffer.from(JSON.stringify(msg));
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length);
  return Buffer.concat([head, body]);
}

// Feed it chunks from stdin; it calls onMessage once per complete frame.
export function nativeReader(onMessage) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      const body = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      onMessage(JSON.parse(body.toString('utf8')));
    }
  };
}

export function lineReader(onMessage) {
  let pending = '';
  return (chunk) => {
    pending += chunk.toString('utf8');
    let nl;
    while ((nl = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      if (line.trim()) onMessage(JSON.parse(line));
    }
  };
}

export const line = (msg) => JSON.stringify(msg) + '\n';
