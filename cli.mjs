#!/usr/bin/env node
// browserbear: drive your real Chrome profiles from the command line, through the
// BrowserBear service. Every command that changes a page prints what changed, so an
// agent rarely needs a separate look.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HOME, SOCKET, line, lineReader } from './service/wire.mjs';
import { createHandoffWatch } from './service/handoff-wait.mjs';

const USAGE = `browserbear: let agents use your real Chrome profiles

  browserbear profiles                          Chrome profiles, and which have BrowserBear connected
  browserbear tabs [--profile p]                open tabs, with ids. The user's own say (the user's)
  browserbear open <url> --profile p [--id]     --id: print only the new tab's id. Use that id from then on,
                                                never a grep of tabs: the user may have the same page open
  browserbear claim <text|tab> [--profile p]    find one of the user's open tabs by URL, title or id, to work in
  browserbear snap <tab> [--full]               what's on the page (a diff after the first look). Plain elements
                                                the page takes clicks on (a <div> with a handler) are "clickable"
  browserbear click <tab> <ref> [--script]       --script: a script click, for pages that ignore real ones
                                                (a link that ignores a real click gets one by itself)
  browserbear click <tab> --text <text> | --css <selector> [--nth n]
                                                for what snap doesn't list: a real click on the element with that
                                                text (exactly, else containing it) or matching that selector, after
                                                hovering it. One hidden until hovered (a card's "Create New") is
                                                shown by hovering what's around it. Looks in iframes too (Google
                                                Drive's share dialog is one). Several matches is an error
                                                listing them, unless --nth picks one. Prints the ref it got.
                                                --reveal <text>: click what has that text first, for options a
                                                card or menu only shows once it's clicked (skipped if they show)
  browserbear hover <tab> <ref> | --text <text> | --css <selector> [--nth n]
                                                put the pointer over it, for menus and buttons that show on hover
  browserbear type <tab> <ref|-> <text> [--submit] [--replace]
                                                fails if the text does not end up in the field
  browserbear key <tab> <key>                   Enter, Escape, Tab, Home, End, F1-F12, Meta+a, Shift+Enter (a line
                                                break), ... A name it doesn't know is an error, never typed
  browserbear goto <tab> <url>
  browserbear read <tab>                        the page's text
  browserbear shot <tab> [file]                 screenshot, prints the PNG path
  browserbear eval <tab> <js>                   the result alone on stdout; notes go to stderr
  browserbear upload <tab> <ref|selector> <file...>
                                                the file input, or the button or label that opens one
                                                ("Choose files"); snap lists hidden inputs as file-input
  browserbear download <tab> <url> [filename] [--to <dir|file>]
                                                fetches with the tab's sign-in and saves it under BrowserBear's
                                                folder (~/Library/Application Support/BrowserBear/out/downloads),
                                                never ~/Downloads, which macOS keeps agents out of. --to moves it
                                                somewhere of yours. Prints the path, size and type: a sign-in
                                                page saved as text/html means the link needed more than the cookies
  browserbear dialog <tab> accept|dismiss [text]
  browserbear show <tab>                        bring a tab forward in its window (real clicks need it)
                                                A tab behind another is hidden, and Chrome slows its timers, so
                                                pages that draw on them load slowly. Every command wakes an agent's
                                                tab without bringing anything forward; one of the user's own stays
                                                hidden, and says so on stderr, until show
  browserbear handoff <tab|url>                 before asking the user to do something in a tab (sign in,
                                                pay, approve): brings the tab's window to the front, in their own
                                                Chrome or the agents' browser. A URL finds the agent tab on that page.
  browserbear handoff <tab|url> --wait [--until-url <glob>] [--until-text <text>] [--timeout <seconds>]
                                                the same, then waits until they've finished and prints where the
                                                tab ended up, so they needn't reply "done". Run it as a background
                                                task. Finished means the tab has left that page and settled on one
                                                that isn't a sign-in, or they clicked Done in the panel or tab, or
                                                moved it back to BrowserBear's window. For a page whose address
                                                won't change, or a checkout with several steps, say what finished
                                                looks like: --until-url (* is a wildcard) or --until-text.
                                                Exits 0 when finished, 2 if they closed the tab, 124 at the timeout
                                                (default 20 minutes; run it again to keep waiting).
  browserbear close <tab> [--user-tab]          only closes a tab an agent opened, unless --user-tab
  browserbear release <tab>                     take BrowserBear's marks off a tab and let go of it

The user's own tabs (not opened by an agent, or handed to them) can be looked at with snap, read, shot
and eval. click, hover, type, key, goto, upload and dialog need claim first, or --user-tab, and only when the
user asked for work in that tab. close refuses them unless --user-tab, so only when they asked for it.
  browserbear reload [--profile p]              reload the extension after changing it (all profiles by default)
  browserbear status
  browserbear fill <tab> [--item <title|id>] [--submit]
                                                sign in from 1Password in the agents' browser: types whichever
                                                of username, password and one-time code the page asks for now
                                                (run it again on the next step). The user approves with Touch ID;
                                                you never see the values. No login saved: handoff instead
  browserbear agent-only [on|off]               keep agents to the agents' own browser (--profile agent) and refuse
                                                the user's own profiles. Off unless turned on

A profile is its whole Chrome name, email or folder, in any case: "Work", "you@company.com", "Default",
"Profile 2". Part of a name doesn't count: you get the candidates back, and an error if two profiles share it.
open and tabs print the profile they actually used. Names and folders need Chrome's profile list, which macOS can block; browserbear profiles shows what works.`;

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
      if (next !== undefined && !next.startsWith('--') && ['profile', 'group', 'until-url', 'until-text', 'timeout', 'item', 'to', 'css', 'text', 'nth', 'reveal'].includes(key)) flags[key] = argv[++i];
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
      return p;
    case 'tabs':
      return p;
    case 'open':
      return { ...p, url: a };
    case 'claim':
      return { ...p, match: pos.join(' ') };
    case 'snap':
      return { tab: a, full: !!flags.full };
    case 'click':
    case 'hover':
      return { tab: a, ref: b, css: flags.css, text: flags.text, nth: flags.nth === undefined ? undefined : flags.nth === true ? NaN : Number(flags.nth), script: cmd === 'click' && !!flags.script, reveal: cmd === 'click' ? flags.reveal : undefined };
    case 'type':
      return { tab: a, ref: b === '-' ? undefined : b, text: rest.join(' '), submit: !!flags.submit, replace: !!flags.replace };
    case 'key':
      return { tab: a, key: b };
    case 'goto':
      return { tab: a, url: b };
    case 'fill':
      return { tab: a, item: flags.item, submit: !!flags.submit };
    case 'read':
    case 'show':
    case 'focus':
    case 'handoff':
    case 'close':
    case 'release':
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
        // A note goes to stderr, so it never mixes into what eval returns.
        if (reply.note) console.error(`browserbear: ${reply.note}`);
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

const WAIT_POLL_MS = 1_500;
const DEFAULT_WAIT_S = 20 * 60; // under the 30 minutes after which Threadbear calls a quiet shell stuck
const CLOSED_AFTER = 5; // looks in a row, since a profile reconnecting can't see its tabs for a moment
const thread = process.env.THREADBEAR_THREAD_ID || undefined;

// Hands the tab over and watches it. The loop lives here, as one short request
// per look, so the service can restart underneath it and nothing keeps
// watching after an agent's killed this. Nothing here touches the debugger:
// attaching one while you type a password would put up Chrome's debugging bar
// and clear your password manager's menu (see cdp in extension/background.js).
async function handoffAndWait({ tab, untilUrl, untilText, timeoutS }) {
  const { tabId, message } = await request({ id: 1, cmd: 'handoff', args: { tab, wait: true }, thread });
  console.log(message);
  const start = Date.now();
  const watch = createHandoffWatch({ untilUrl, untilText, start });
  let last = null;
  let goneFor = 0;
  while (Date.now() - start < timeoutS * 1000) {
    const look = await request({ id: 1, cmd: 'handoffLook', args: { tab: tabId, text: untilText }, thread }).catch(() => ({ unknown: true }));
    if (look.textUnsupported) throw new Error(`this profile's BrowserBear extension is too old for --until-text; use --until-url, or update it`);
    goneFor = look.gone ? goneFor + 1 : 0;
    if (goneFor >= CLOSED_AFTER) {
      console.log(`tab ${tabId} was closed before they finished${last ? `; it was last on ${last.title} <${last.url}>` : ''}. Ask them what happened rather than assume.`);
      return 2;
    }
    if (!look.gone && !look.unknown) {
      last = look;
      const why = watch.see(look, Date.now());
      if (why) {
        await request({ id: 1, cmd: 'handoffFinished', args: { tab: tabId }, thread }).catch(() => {});
        console.log(`the user has finished in tab ${tabId} (${why}). It's now on: ${look.title} <${look.url}>`);
        return 0;
      }
    }
    await new Promise((r) => setTimeout(r, WAIT_POLL_MS));
  }
  console.log(`timed out after ${timeoutS} s waiting for the user in tab ${tabId}${last ? `, still on ${last.title} <${last.url}>` : ''}. They may have stepped away: ask them, or run this again to keep waiting.`);
  return 124;
}

// download --to: done here rather than in the service, as the agent may be
// able to write where the service (started by Chrome) can't, and vice versa.
// A folder (one that exists, or ends in /) keeps the file's own name, with
// " (2)" and so on if that's taken: the name can come from the server, which
// shouldn't get to replace a file of the agent's (Codex review, 16 Nov). A
// file path that's already there is an error, never overwritten.
function moveTo(from, to) {
  if (to === true) throw new Error('--to needs a folder or file path');
  let dest = path.resolve(to);
  const intoDir = to.endsWith('/') || fs.statSync(dest, { throwIfNoEntry: false })?.isDirectory();
  if (intoDir) fs.mkdirSync(dest, { recursive: true });
  const { name, ext } = path.parse(path.basename(from));
  for (let n = 1; ; n++) {
    const target = intoDir ? path.join(dest, n === 1 ? name + ext : `${name} (${n})${ext}`) : dest;
    try {
      fs.copyFileSync(from, target, fs.constants.COPYFILE_EXCL);
      dest = target;
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (!intoDir) throw new Error(`--to: ${target} is already there; the download is still at ${from}`);
    }
  }
  fs.rmSync(from);
  // Only the download's own folder in BrowserBear's, never Downloads or anywhere
  // an older service saved it.
  if (path.dirname(path.dirname(from)) === path.join(HOME, 'out', 'downloads')) fs.rmdirSync(path.dirname(from));
  return dest;
}

// exitCode rather than process.exit(): exiting inside the top-level await
// makes Node print "Detected unsettled top-level await" under every error.
const { cmd, pos, flags } = parse(process.argv.slice(2));
const args = cmd && argsFor(cmd, pos, flags);
// Lets an agent into one of the user's own tabs (see USAGE).
if (args && flags['user-tab']) args.userTab = true;
// `open --id`: just the new tab's id, so `tab=$(browserbear open ... --id)` gets
// the right one. The service always starts with "opened tab <id>", even when
// the page went wrong after it opened.
const openedId = (text) => /^opened tab (\d+)/.exec(text)?.[1];
// A switch file the service checks on every command, so it works whether or
// not the service is running (Mike's agent-only trial, 6 Nov 2026).
const AGENT_ONLY = path.join(HOME, 'agent-only');
if (cmd === 'agent-only') {
  const want = pos[0];
  if (want === 'on') fs.mkdirSync(HOME, { recursive: true }), fs.writeFileSync(AGENT_ONLY, `turned on ${new Date().toISOString()}\n`);
  else if (want === 'off') fs.rmSync(AGENT_ONLY, { force: true });
  else if (want !== undefined) {
    console.error('browserbear: agent-only takes on or off');
    process.exitCode = 1;
  }
  if (!process.exitCode) {
    console.log(fs.existsSync(AGENT_ONLY)
      ? "agent-only is on: agents use only the agents' own browser (--profile agent); the user's profiles are refused"
      : "agent-only is off: agents can use the user's connected profiles");
  }
} else if (!args) {
  console.log(USAGE);
  process.exitCode = cmd && cmd !== 'help' ? 1 : 0;
} else {
  try {
    if (cmd === 'handoff' && (flags.wait || flags['until-url'] || flags['until-text'])) {
      const timeoutS = flags.timeout === undefined ? DEFAULT_WAIT_S : Number(flags.timeout);
      if (!(timeoutS > 0)) throw new Error(`--timeout takes a number of seconds, not ${flags.timeout}`);
      for (const f of ['until-url', 'until-text']) if (flags[f] === true) throw new Error(`--${f} needs a value`);
      process.exitCode = await handoffAndWait({ tab: args.tab, untilUrl: flags['until-url'], untilText: flags['until-text'], timeoutS });
    } else {
      // Which Threadbear thread is asking, so the tabs it uses carry its name
      // (service/marks.mjs). Unset outside Threadbear: the tab says "agent".
      const result = await request({ id: 1, cmd, args, thread });
      if (cmd === 'download' && flags.to) result.path = moveTo(result.path, flags.to);
      if (cmd === 'open' && flags.id) console.log(openedId(result));
      else console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
    }
  } catch (e) {
    if (cmd === 'open' && flags.id && openedId(e.message)) console.log(openedId(e.message));
    console.error(`browserbear: ${e.message}`);
    process.exitCode = 1;
  }
}
