# Chrome Web Store listing (draft)

Store build 0.1.2 was submitted as Paws on 29 Oct 2026, before the rename. Once
it's approved, upload a BrowserBear build with this text, and point the privacy and
homepage URLs at browserbear.mikecann.app (paws.mikecann.app serves the same site
until then).

Visibility: **Unlisted**. Upload `dist/browserbear-<version>.zip` from
`scripts/package.sh`.

## Store listing

**Name:** BrowserBear

**Summary** (132 characters max):
Lets AI agents on your Mac use this Chrome profile, through the BrowserBear app. Does nothing on its own.

**Description:**

BrowserBear lets the AI agents you run on your own Mac (Claude Code, Codex and others) use
your Chrome: the profiles you're signed into and the tabs you already have open.

It's one half of a pair. The other half is the BrowserBear service, a small program you
install on your Mac from github.com/mikecann/browserbear. Without it, this extension does
nothing.

- Agents ask for a profile by its name ("Work") instead of guessing, so they don't end
  up in the wrong Google account.
- Agent tabs open in a window of their own, in a tab group named after the job.
- While an agent is working, Chrome shows "BrowserBear started debugging this browser". That's
  Chrome's own notice; BrowserBear stops 30 seconds after the last command and the bar goes.
- Nothing leaves your Mac. The extension only talks to the BrowserBear service on the same
  computer, through Chrome's native messaging.

**Category:** Developer Tools. **Language:** English.

**Icon:** `extension/icons/icon-128.png`. **Screenshot:** `design/store-screenshot.png`
(1280x800).

## Privacy practices

**Single purpose:** Lets AI agents running on the user's own computer read and operate
tabs in this Chrome profile, through a local companion app.

**Permission justifications:**

- `debugger`: the agent reads the page's accessibility tree and clicks and types in
  the tab, through the Chrome DevTools Protocol. This is the core of what it does.
- `nativeMessaging`: the only connection, to the BrowserBear service on the same Mac.
- `tabs`, `tabGroups`: list open tabs so the user can point an agent at one, and keep
  the agent's own tabs together in a named group.
- `downloads`: save a file the agent was asked to fetch, and tell it where it landed.
- `identity`, `identity.email`: read which Google account this profile is signed into,
  so agents can pick the right profile by account. The email stays on the device.
- `storage`: remember a random id for this profile, and the agent window's id.
- `alarms`: reopen the connection to the local service if it drops.
- Host permission `<all_urls>`: agents work on whatever site the user asks for.

**Remote code:** No. All code is in the package; commands from the local app are data
(DevTools Protocol calls), not code.

**Data usage:** Handles "Website content" and "Personally identifiable information"
(the profile's email) only to provide the single purpose, only on the user's device.
Not sold, not transferred, not used for anything else.

**Privacy policy URL:** https://browserbear.mikecann.app/privacy

**Homepage URL:** https://browserbear.mikecann.app
