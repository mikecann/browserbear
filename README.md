# BrowserBear

Lets your local AI agents use your real Chrome: your profiles, your sign-ins, the tabs
you already have open. Any agent that can run a command can use it (Claude, Codex,
anything else), and Threadbear will give its threads BrowserBear tools of their own.

It's early: macOS and Chrome only, tested on Chrome 156. It was called Paws until 30 Oct 2026.

## Why

The agents' own browser tools kept letting us down: picking the wrong Chrome profile
or Google account, dropping the connection, clicks timing out, and secrets having to be
smuggled out through the clipboard. BrowserBear keeps the agent in the profile you named and
the tab you pointed at, and keeps everything on your Mac.

## How it fits together

```
browserbear CLI (or Threadbear)
  → BrowserBear service, one per Mac, on a Unix socket in ~/Library/Application Support/BrowserBear
  → native host, one per Chrome profile, started by Chrome
  → the BrowserBear extension in that profile (a thin pipe to chrome.debugger)
  → the tab
```

- Profiles are named the way Chrome names them ("Work"), or by email or folder,
  never by a number that changes between connects. Names and folders come from
  Chrome's `Local State` file; where macOS blocks that, only the email works, and
  `browserbear profiles` says so.
- Snapshots list headings and things you can click or type in, with refs (`e12`) that
  stay on the same element. After the first look you get only what changed, so most
  steps cost a few hundred tokens rather than 15k.
- Everything that changes a page answers with that diff, so there's no separate look.
- The extension detaches from a tab 30 s after its last command, so Chrome's "started
  debugging this browser" bar doesn't hang around.
- All the page logic is in the service; the extension rarely needs to change. The
  service restarts itself within a couple of seconds of its code changing (once nothing
  is in flight), so there's nothing to kill after an edit. Refs don't survive that: snap
  again.
- A click, key or submit that starts a navigation waits for the next page before it
  answers, and `read` waits for a page with a body.
- Chrome won't let a debugger into a tab holding another extension's frame (a password
  manager's inline menu), so the extension blanks those frames and gets back in. That
  needs the `scripting` permission.

## Install (for now)

```sh
./scripts/install.sh     # native host for every profile, and `browserbear` on your PATH
```

Then add the extension to each Chrome profile you want agents to use. Once the
Chrome Web Store listing is live (it's in review), `./scripts/install.sh --store` makes
Chrome offer it in every profile, and each one asks you once. Until then:
`chrome://extensions`, turn on Developer mode, Load unpacked, pick this repo's `extension`
folder. For uploads, open
the extension's Details and turn on "Allow access to file URLs". The extension's id is
fixed (`iljcldkflmlnmfhbllafbbfnchhoccok`) by the key in its manifest.

The extension opens a setup page when it's first added, and again whenever you
click its toolbar button. It checks the Mac side, the name agents will use for that
profile, and file access, and each row turns green by itself once it's done.
`browserbear profiles` shows which profiles are connected.

## Use

```sh
browserbear profiles
browserbear tabs --profile Work
browserbear claim studio.youtube.com          # one of your open tabs, and what's on it
browserbear open https://example.com --profile Work
browserbear click 1234 e12
browserbear type 1234 e7 "Hello" --submit
browserbear upload 1234 e12 ~/talk.mp3         # e12 can be the "Choose files" button
browserbear read 1234                          # page text; long pages go to a file
browserbear shot 1234                          # prints the PNG path
browserbear handoff 1234                       # your turn: the tab moves into your window
```

Agents work in a window of BrowserBear's own, so they never take over the tab
you're looking at. When an agent needs you to do something in one of its tabs
(sign in, pay, approve), `handoff` moves that tab into the Chrome window you
last used and brings it to the front, since BrowserBear's window may be on a
screen you aren't looking at. `open` and `goto` say so when a page looks like
a sign-in. Given a URL, `handoff` finds the agent tab on that page; Threadbear
does that when you click a link an agent gave you, so you don't end up with
two tabs of the same sign-in.

Every tab an agent uses is marked, so you can tell it from yours. The tab's
title starts with 🐻 and the thread's name, its icon gets a dot (green while
the agent works in it, amber when it's handed to you, grey while the thread
has it but isn't using it right now), and a pill in the page says what the
agent is doing, with Open thread (in the Threadbear app, or its website without it), Stop and ✕ (leave this tab alone). The marks
come off when the thread finishes its turn without needing you. The CLI passes
`THREADBEAR_THREAD_ID` along and the service asks Threadbear's `tb` for the
thread's name and state; outside Threadbear the tab just says "agent". The
pill steps aside while the agent clicks or takes a screenshot, and agents see
the page's own title.

Uploads never open Chrome's file picker. Give `upload` the file input itself
(`snap` lists them as `file-input`, hidden ones too, since sites usually hide the
real one), the button or label that stands for it, or a CSS selector, and it
finds the input and sets the files there. A button whose input only appears when
it's clicked gets clicked, with the picker caught before it opens. Pages that use
`showOpenFilePicker` instead of an input can't be filled this way.

When a tab stops answering, BrowserBear works out why instead of timing out
again and again. If Chrome answers but the page doesn't, the page's own scripts
are stuck or flat out (a live chart did this on BTC Markets), and the agent is
told to wait or open the page fresh; after that, each command takes a quick look
first rather than waiting the full 20 s. If Chrome doesn't answer either, the
debugger session is stuck, so BrowserBear drops it and starts a fresh one,
sending the command again only if it just reads the page.

A page that fails to load comes back as an error from `open` and `goto` saying why
(`certificate error on example.com (net::ERR_CERT_COMMON_NAME_INVALID)`), with the
tab's id, rather than looking like success. Chrome keeps debuggers out of its warning
pages (certificate errors, Safe Browsing), so `read`, `snap` and `eval` name the problem
there, and `goto` still gets the tab out, through `chrome.tabs` instead of the debugger.

A real click on a link that changes nothing but focus gets clicked again by
script, since following a link twice is harmless. For anything else that ignores
a real click, the agent is told about `--script`.

`browserbear help` lists everything.

## Tests

```sh
npm test
```

The end-to-end test plays the extension over native messaging to the real host, which
starts the real service, which the real CLI talks to. No Chrome needed.

## Not yet

- Cross-origin iframes (Google sign-in, payment frames) aren't in snapshots.
- No approvals yet for posting, sending or buying; Threadbear will own those.
- No `secret_to` (move a key from a page into Convex env or Keychain without it
  passing through the agent).
- Installing into every profile at once (unlisted Web Store listing plus an External
  Extensions file) and a LaunchAgent for the service.
