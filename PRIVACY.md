# BrowserBear privacy policy

Last updated 29 October 2026.

BrowserBear is a Chrome extension plus a small service that runs on your own Mac. It lets AI
agents that you run on that Mac use your Chrome profiles.

**What it handles.** The content of the pages an agent works on (text, the structure of
the page, screenshots when asked), the list of your open tabs, and the email address of
the Google account each Chrome profile is signed into.

**Where it goes.** Only to the BrowserBear service on the same computer, over Chrome's native
messaging. From there it goes to whatever agent you pointed at it, which you run and
control. BrowserBear itself sends nothing over the internet, has no server, no analytics and
no accounts.

**What's kept.** Screenshots and long page text an agent asks for are written to
`~/Library/Application Support/BrowserBear/out` on your Mac, and a log of connections (not page
content) to `~/Library/Application Support/BrowserBear/logs`. Delete those folders at any time.

**Sharing.** Nothing is sold or shared with anyone.

**Contact.** The developer email on the Chrome Web Store listing, or an issue on the GitHub repo.
