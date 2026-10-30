// What the setup page shows, worked out from what the extension can see.
// Pure, so the tests can check every state without Chrome.
//
// `link` is the background's view of the chain to the Mac:
//   host:    'connecting' | 'up' | 'error'  (the native host Chrome starts)
//   error:   Chrome's message when the host couldn't start
//   service: true once the host has reached the BrowserBear service
//   profile: { name, email, dir } once the service has said who this profile is
// `fileAccess` is chrome.extension.isAllowedFileSchemeAccess().

export const INSTALL_COMMAND = './scripts/install.sh';

// Each row: state is 'done' (green), 'missing' (red), 'optional' (grey, only
// matters for some jobs) or 'checking' (grey, waiting to hear back).
// action is at most one button: copy a command, or open a Chrome page.
export function setupView({ link, fileAccess, extensionId }) {
  const host = link?.host || 'connecting';
  const profile = link?.profile || null;
  const reached = host === 'up' && link?.service;

  const mac =
    host === 'error'
      ? {
          state: 'missing',
          detail: 'Run this in the browserbear folder on your Mac.',
          action: { kind: 'copy', label: 'Copy', text: INSTALL_COMMAND },
          error: link?.error || null,
        }
      : reached
        ? { state: 'done', detail: 'The service agents talk to.' }
        : { state: 'checking', detail: host === 'up' ? 'Starting the service.' : 'Checking.' };

  // The service names a profile from Chrome's own list, matched by the
  // signed-in email. With no email it can't tell profiles apart, so agents
  // can't pick this one by name.
  const label = profile?.name || profile?.email;
  const named = profile
    ? label
      ? { state: 'done', detail: `Agents call it "${label}".` }
      : {
          state: 'missing',
          detail: 'Sign in to Chrome here so agents can tell this profile apart.',
          action: { kind: 'open', label: 'Sign in', url: 'chrome://settings/people' },
        }
    : { state: mac.state === 'missing' ? 'missing' : 'checking', detail: 'Not connected yet.' };

  const files = fileAccess
    ? { state: 'done', detail: 'Agents can upload files from your Mac.' }
    : {
        state: 'optional',
        detail: 'Optional. Turn on "Allow access to file URLs".',
        action: { kind: 'open', label: 'Open', url: `chrome://extensions/?id=${extensionId}` },
      };

  const rows = [
    { id: 'mac', title: 'BrowserBear on your Mac', ...mac },
    { id: 'profile', title: 'This profile', ...named },
    { id: 'files', title: 'File uploads', ...files },
  ];
  const left = rows.filter((r) => r.state === 'missing' || r.state === 'checking').length;
  const allSet = left === 0;
  return {
    allSet,
    title: allSet ? 'BrowserBear is all set' : 'Set up BrowserBear',
    subtitle: allSet ? 'You can close this.' : `${left} ${left === 1 ? 'thing' : 'things'} left in this profile.`,
    rows,
  };
}
