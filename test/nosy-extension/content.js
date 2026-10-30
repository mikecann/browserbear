// Plays a password manager (1Password's inline menu): focusing a field puts
// this extension's own page in an iframe, inside a closed shadow root. Chrome
// won't let another extension's debugger near a tab while that's there.
const menu = () => {
  if (document.querySelector('nosy-menu')) return;
  const host = document.createElement('nosy-menu');
  const root = host.attachShadow({ mode: 'closed' });
  const frame = document.createElement('iframe');
  frame.src = chrome.runtime.getURL('menu.html');
  root.append(frame);
  document.body.append(host);
};
document.addEventListener('focusin', (e) => e.target instanceof HTMLInputElement && menu());
// ?now: the menu is already up before BrowserBear first attaches.
if (location.search === '?now') addEventListener('load', menu);
