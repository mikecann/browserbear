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
  never by a number that changes between connects.
- Snapshots list headings and things you can click or type in, with refs (`e12`) that
  stay on the same element. After the first look you get only what changed, so most
  steps cost a few hundred tokens rather than 15k.
- Everything that changes a page answers with that diff, so there's no separate look.
- The extension detaches from a tab 30 s after its last command, so Chrome's "started
  debugging this browser" bar doesn't hang around.
- All the page logic is in the service; the extension rarely needs to change.

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
browserbear open https://example.com --profile Work --group "My thread"
browserbear click 1234 e12
browserbear type 1234 e7 "Hello" --submit
browserbear read 1234                          # page text; long pages go to a file
browserbear shot 1234                          # prints the PNG path
```

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
