#!/usr/bin/env node
// browserbear: drive your real Chrome profiles from the command line, through the
// BrowserBear service. Every command that changes a page prints what changed, so an
// agent rarely needs a separate look.
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HOME, SOCKET, line, lineReader } from './service/wire.mjs';

const USAGE = `browserbear: let agents use your real Chrome profiles

  browserbear profiles                          Chrome profiles, and which have BrowserBear connected
  browserbear tabs [--profile p]                open tabs, with ids
  browserbear open <url> --profile p
  browserbear claim <text> [--profile p]        find one of your open tabs by URL or title
  browserbear snap <tab> [--full]               what's on the page (a diff after the first look)
  browserbear click <tab> <ref> [--script]       --script: a script click, for pages that ignore real ones
                                                (a link that ignores a real click gets one by itself)
  browserbear type <tab> <ref|-> <text> [--submit] [--replace]
  browserbear key <tab> <key>                   Enter, Escape, Tab, Meta+a, ...
  browserbear goto <tab> <url>
  browserbear read <tab>                        the page's text
  browserbear shot <tab> [file]                 screenshot, prints the PNG path
  browserbear eval <tab> <js>
  browserbear upload <tab> <ref|selector> <file...>
                                                the file input, or the button or label that opens one
                                                ("Choose files"); snap lists hidden inputs as file-input
  browserbear download <tab> <url> [filename]
  browserbear dialog <tab> accept|dismiss [text]
  browserbear show <tab>                        bring a tab forward in its window (real clicks need it)
  browserbear handoff <tab|url>                 before asking the user to do something in a tab (sign in,
                                                pay, approve): moves it from BrowserBear's window into theirs
                                                and focuses it. A URL finds the agent tab on that page.
  browserbear close <tab>
  browserbear reload                            reload the extension everywhere after changing it
  browserbear status

A profile is its Chrome name, email or folder: "Work", "you@company.com", "Default", "Profile 2".
Names and folders need Chrome's profile list, which macOS can block; browserbear profiles shows what works.`;

function parse(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      // --group is gone (Chrome kept every group on the bookmarks bar), but
      // still eats its value so old commands don't read it as a URL.
      if (next !== undefined && !next.startsWith('--') && ['profile', 'group'].includes(key)) flags[key] = argv[++i];
      else flags[key] = true;
    } else pos.push(a);
  }
  return { cmd: pos.shift(), pos, flags };
}

function argsFor(cmd, pos, flags) {
  const [a, b, ...rest] = pos;
  const p = { profile: flags.profile };
  switch (cmd) {
    case 'profiles':
    case 'status':
    case 'reload':
      return {};
    case 'tabs':
      return p;
    case 'open':
      return { ...p, url: a };
    case 'claim':
      return { ...p, match: pos.join(' ') };
    case 'snap':
      return { tab: a, full: !!flags.full };
    case 'click':
      return { tab: a, ref: b, script: !!flags.script };
    case 'type':
      return { tab: a, ref: b === '-' ? undefined : b, text: rest.join(' '), submit: !!flags.submit, replace: !!flags.replace };
    case 'key':
      return { tab: a, key: b };
    case 'goto':
      return { tab: a, url: b };
    case 'read':
    case 'show':
    case 'focus':
    case 'handoff':
    case 'close':
      return { tab: a };
    case 'shot':
      return { tab: a, file: b && path.resolve(b) };
    case 'eval':
      return { tab: a, js: [b, ...rest].join(' ') };
    case 'cdp':
      return { tab: a, method: b, params: rest[0] };
    case 'upload':
      return { tab: a, ref: b, files: rest };
    case 'download':
      return { tab: a, url: b, filename: rest[0] };
    case 'dialog':
      return { tab: a, action: b, text: rest.join(' ') || undefined };
    default:
      return null;
  }
}

function request(msg, { attempt = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(SOCKET);
    let answered = false;
    s.on('connect', () => s.write(line(msg)));
    s.on(
      'data',
      lineReader((reply) => {
        answered = true;
        s.end();
        reply.ok ? resolve(reply.result) : reject(new Error(reply.error));
      }),
    );
    // The service restarts itself when its code changes; a request that
    // caught it on the way out goes to the new one.
    s.on('close', () => {
      if (answered) return;
      if (attempt < 20) setTimeout(() => request(msg, { attempt: attempt + 1 }).then(resolve, reject), 250);
      else reject(new Error('the BrowserBear service closed the connection without answering'));
    });
    s.on('error', (e) => {
      answered = true; // handled here, not by close
      if (attempt < 20 && (e.code === 'ENOENT' || e.code === 'ECONNREFUSED')) {
        // Chrome's hosts normally start the service; start it here too so the
        // CLI can at least say which profiles aren't connected. The service
        // exits by itself if another one won the race.
        if (attempt === 0) {
          const service = path.join(path.dirname(fileURLToPath(import.meta.url)), 'service', 'service.mjs');
          spawn(process.execPath, [service], { detached: true, stdio: 'ignore', cwd: HOME }).unref();
        }
        setTimeout(() => request(msg, { attempt: attempt + 1 }).then(resolve, reject), 250);
      } else reject(e);
    });
  });
}

// exitCode rather than process.exit(): exiting inside the top-level await
// makes Node print "Detected unsettled top-level await" under every error.
const { cmd, pos, flags } = parse(process.argv.slice(2));
const args = cmd && argsFor(cmd, pos, flags);
if (!args) {
  console.log(USAGE);
  process.exitCode = cmd && cmd !== 'help' ? 1 : 0;
} else {
  try {
    // Which Threadbear thread is asking, so the tabs it uses carry its name
    // (service/marks.mjs). Unset outside Threadbear: the tab says "agent".
    const result = await request({ id: 1, cmd, args, thread: process.env.THREADBEAR_THREAD_ID || undefined });
    console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
  } catch (e) {
    console.error(`browserbear: ${e.message}`);
    process.exitCode = 1;
  }
}
