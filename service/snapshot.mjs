// Turns Chrome's accessibility tree into a short list an agent can act on:
//
//   # Channel content
//   e4 button "Upload videos"
//   e7 textbox "Title" = "My video"
//   e9 checkbox "Made for kids" [checked]
//   e11 file-input #video-file accept="video/*" [hidden]
//
// Only headings (for orientation) and things you can interact with make the
// cut; a full tree runs 14-19k tokens on real sites, this is usually under 1k.
// Refs (e4) stick to the same DOM node for as long as the service runs, so a
// diff between two snapshots reads as "what changed", not a renumbering.

const INTERACTIVE = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch',
  'slider', 'spinbutton', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab',
  'option', 'treeitem', 'listbox',
]);
// Containers worth naming because they change what's clickable (a dialog
// covering the page, an alert that just appeared).
const LANDMARKS = new Set(['dialog', 'alertdialog', 'alert']);
const FLAGS = ['disabled', 'checked', 'pressed', 'selected', 'expanded', 'focused', 'required', 'invalid'];
// Not plain "pass": that masked every "passport" field on GOV.UK (30 Oct).
const SECRET_NAME = /pass(word|code|phrase)|\bpass\b|secret|token|api.?key|cvc|cvv|card.?number|one.?time|otp/i;
const MAX_NAME = 80;

// Per-tab ref memory: backendDOMNodeId -> "eN".
export class RefMap {
  constructor() {
    this.byNode = new Map();
    this.byRef = new Map();
    this.next = 1;
  }
  ref(backendId) {
    let r = this.byNode.get(backendId);
    if (!r) {
      r = `e${this.next++}`;
      this.byNode.set(backendId, r);
      this.byRef.set(r, backendId);
    }
    return r;
  }
  node(ref) {
    return this.byRef.get(ref);
  }
}

const clip = (s) => {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > MAX_NAME ? s.slice(0, MAX_NAME - 1) + '…' : s;
};

const propValue = (node, name) => node.properties?.find((p) => p.name === name)?.value?.value;

// File inputs come from the DOM (service.mjs's fileInputs), not the
// accessibility tree: sites hide the real one behind a styled "Choose files"
// button, and a hidden element isn't in the tree at all. Without them listed,
// an agent has nothing to pass to upload (Adobe Podcast Enhance, 30 Oct).
function fileInputLine(ref, f, axName, hidden) {
  let text = `${ref} file-input`;
  const name = axName || clip(f.label);
  if (name) text += ` "${name}"`;
  if (f.id) text += ` #${f.id}`;
  if (f.accept) text += ` accept="${clip(f.accept)}"`;
  const flags = [f.multiple && 'multiple', f.disabled && 'disabled', hidden && 'hidden'].filter(Boolean);
  if (flags.length) text += ` [${flags.join(', ')}]`;
  return text;
}

// What a plain clickable element says: the text under it in the tree, as a
// <div> has no accessible name of its own.
function textUnder(node, byId, depth = 0) {
  if (!node || depth > 12) return '';
  if (node.role?.value === 'StaticText') return node.name?.value || '';
  return (node.childIds || []).map((id) => textUnder(byId.get(id), byId, depth + 1)).join(' ');
}

// fileInputs: backendDOMNodeId -> { id, label, accept, multiple, disabled }
// frames: backendDOMNodeId of an <iframe> -> the lines for what's inside it,
// put in where the iframe is (a cross-origin one isn't in this tree).
// clickable: backendDOMNodeId -> { label } for drawn elements with no role of
// their own that the page handles clicks on (a click listener, or where
// cursor: pointer starts). Zoho Campaigns builds its campaign-type cards,
// dropdowns and icon links out of <div>, <p> and <a> with no href (17 Nov), so
// without these an agent had nothing to click. Only the innermost is listed,
// and none that holds a real control, so a React root (which listens for
// every click) or a card around its own button doesn't swallow what's inside.
export function compact(axNodes, refs, fileInputs = new Map(), masked = new Set(), frames = new Map(), clickable = new Map()) {
  const byId = new Map(axNodes.map((n) => [n.nodeId, n]));
  const root = axNodes.find((n) => !n.parentId) || axNodes[0];
  const lines = [];
  const seen = new Set();
  const shown = new Set(); // file inputs the tree already had
  const placed = new Set(); // frames put in where they are

  // aria-hidden says a page doesn't mean it for anyone to use, and BrowserBear's
  // own pill in the tab is hidden that way.
  const ariaHidden = (n) => n.ignoredReasons?.some((r) => r.name === 'ariaHiddenElement' || r.name === 'ariaHiddenSubtree');
  const isControl = (n) => !n.ignored && INTERACTIVE.has(n.role?.value) && n.backendDOMNodeId;
  // Whether anything under a node is a control or another clickable element.
  const holds = new Map();
  const holdsAction = (node, depth = 0) => {
    if (!node || depth > 400) return false;
    if (holds.has(node.nodeId)) return holds.get(node.nodeId);
    holds.set(node.nodeId, false); // a cycle can't hold anything
    let any = false;
    for (const id of node.childIds || []) {
      const c = byId.get(id);
      if (!c) continue;
      // Every child is visited, so each one's answer is cached for the walk.
      if (holdsAction(c, depth + 1) || isControl(c) || clickable.has(c.backendDOMNodeId) || frames.has(c.backendDOMNodeId)) any = true;
    }
    holds.set(node.nodeId, any);
    return any;
  };

  const walk = (node, inControl = false) => {
    if (!node || seen.has(node.nodeId)) return;
    seen.add(node.nodeId);
    const role = node.role?.value;
    const name = clip(node.name?.value);
    if (frames.has(node.backendDOMNodeId)) {
      placed.add(node.backendDOMNodeId);
      lines.push(...frames.get(node.backendDOMNodeId));
    }
    let control = inControl;
    if (!isControl(node) && !inControl && clickable.has(node.backendDOMNodeId) && !ariaHidden(node) && !fileInputs.has(node.backendDOMNodeId) && !holdsAction(node)) {
      const text = name || clip(textUnder(node, byId)) || clip(clickable.get(node.backendDOMNodeId).label);
      lines.push(`${refs.ref(node.backendDOMNodeId)} clickable${text ? ` "${text}"` : ''}`);
      control = true;
    } else if (!node.ignored) {
      if (fileInputs.has(node.backendDOMNodeId)) {
        shown.add(node.backendDOMNodeId);
        lines.push(fileInputLine(refs.ref(node.backendDOMNodeId), fileInputs.get(node.backendDOMNodeId), name, false));
      } else if (role === 'heading' && name) {
        lines.push(`${'#'.repeat(Math.min(Number(propValue(node, 'level')) || 2, 6))} ${name}`);
      } else if (LANDMARKS.has(role)) {
        lines.push(`[${role}${name ? ` "${name}"` : ''}]`);
      } else if (INTERACTIVE.has(role) && node.backendDOMNodeId) {
        let text = `${refs.ref(node.backendDOMNodeId)} ${role}`;
        if (name) text += ` "${name}"`;
        const value = node.value?.value;
        if (value !== undefined && value !== '' && value !== name) {
          text += SECRET_NAME.test(name) || masked.has(node.backendDOMNodeId) ? ' = "••••"' : ` = "${clip(value)}"`;
        }
        const flags = FLAGS.filter((f) => {
          const v = propValue(node, f);
          return v === true || v === 'true' || v === 'mixed';
        });
        if (flags.length) text += ` [${flags.join(', ')}]`;
        lines.push(text);
        control = true;
      }
    }
    for (const id of node.childIds || []) walk(byId.get(id), control);
  };
  walk(root);
  // A frame whose iframe the tree doesn't show still has controls worth listing.
  for (const [id, inner] of frames) if (!placed.has(id)) lines.push(...inner);
  // The rest aren't in the tree, so they're hidden; they go at the end.
  for (const [id, f] of fileInputs) if (!shown.has(id)) lines.push(fileInputLine(refs.ref(id), f, '', true));
  return lines;
}

// Returns the cheaper of a diff against the last snapshot and the full list.
export function diff(before, after) {
  if (!before) return { full: true, text: after.join('\n') };
  const was = new Set(before);
  const now = new Set(after);
  const added = after.filter((l) => !was.has(l));
  const removed = before.filter((l) => !now.has(l));
  if (!added.length && !removed.length) return { full: false, text: '(no change)' };
  const text = [...removed.map((l) => `- ${l}`), ...added.map((l) => `+ ${l}`)].join('\n');
  // A navigation changes nearly everything; then the plain list is shorter.
  if (text.length >= after.join('\n').length) return { full: true, text: after.join('\n') };
  return { full: false, text: `${text}\n(${after.length - added.length} unchanged)` };
}

// Whether two snapshots differ only in what has focus. A click focuses what it
// lands on, so a click the page ignored still changes that much.
export function sameApartFromFocus(before, after) {
  if (!before || before.length !== after.length) return false;
  const unfocus = (l) => l.replace(/ \[([^\]]*)\]$/, (_, f) => {
    const rest = f.split(', ').filter((x) => x !== 'focused');
    return rest.length ? ` [${rest.join(', ')}]` : '';
  });
  return before.every((l, i) => unfocus(l) === unfocus(after[i]));
}
