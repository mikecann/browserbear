// The setup page: asks the background how far the chain to the Mac gets,
// checks file access, and redraws every second so rows turn green by
// themselves once a step is done.
import { setupView } from './setup-rows.js';

const POLL_MS = 1000;

async function check() {
  const { link } = await chrome.runtime.sendMessage({ type: 'setup-status' }).catch(() => ({ link: null }));
  const fileAccess = await chrome.extension.isAllowedFileSchemeAccess();
  return setupView({ link, fileAccess, extensionId: chrome.runtime.id });
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter(Boolean));
  return node;
}

function button(action) {
  const b = el('button', { textContent: action.label });
  b.addEventListener('click', async () => {
    if (action.kind === 'copy') {
      await navigator.clipboard.writeText(action.text);
      b.textContent = 'Copied';
      setTimeout(() => (b.textContent = action.label), 1500);
    }
    // window.open can't reach chrome:// pages; tabs.create can.
    if (action.kind === 'open') chrome.tabs.create({ url: action.url });
  });
  return b;
}

function rowNode(row) {
  const text = el(
    'div',
    { className: 'text' },
    el('strong', { textContent: row.title }),
    el('p', { textContent: row.detail, title: row.error || '' }),
    row.action?.kind === 'copy' && el('code', { textContent: row.action.text }),
  );
  const side = el('div', { className: 'side' });
  if (row.state === 'done') side.append(el('span', { className: 'check', textContent: '✓', ariaLabel: 'Done' }));
  else if (row.action) side.append(button(row.action));
  const li = el('li', { className: row.state }, el('span', { className: 'dot' }), text, side);
  li.dataset.id = row.id; // dataset is getter-only, so it can't go through el()'s Object.assign
  return li;
}

// Only redraw when something changed, so a button isn't swapped out from
// under a click (and "Copied" isn't reset) every second.
let last = '';
function render(view) {
  const key = JSON.stringify(view);
  if (key === last) return;
  last = key;
  document.getElementById('title').textContent = view.title;
  document.getElementById('subtitle').textContent = view.subtitle;
  document.getElementById('rows').replaceChildren(...view.rows.map(rowNode));
}

document.getElementById('done').addEventListener('click', () => window.close());

async function loop() {
  try {
    render(await check());
  } finally {
    setTimeout(loop, POLL_MS);
  }
}
loop();
