// Decides when the user has finished in a tab handed to them, from repeated
// looks at it, so they needn't go back to the thread and type "done" (5 Nov).
// Pure, and run by the CLI rather than the service: the service restarts
// whenever its code changes, and a wait can last twenty minutes.

// Long enough for a redirect chain (OAuth's hops are usually under a second
// each) to get to where it's going.
const SETTLE_MS = 2_500;
// Some apps never reach "complete" (the Cloud console's spinners).
const STILL_LOADING_MS = 15_000;
// Handed off mid-redirect: the page it lands on is the handoff page, not the hop.
const BASELINE_MS = 5_000;
// With --until, the start ends after this many looks even if the page never
// settled (one that can't be asked about its text, say): about 15 s.
const MAX_START_LOOKS = 10;

// Pages of a sign-in, in the host and path only: a query can say anything
// (Google's says continue=console.cloud.google.com). Whole words, so "/authors"
// and "/verified-buyers" don't count. Moving between these isn't finishing:
// Google goes from a password page to a code page to a consent page.
const SIGN_IN_HOST = /^(accounts|login|signin|auth|sso|id)\./i;
const SIGN_IN_WORD = /(^|[./_-])(log-?_?in|sign-?_?(in|on|up)|o?auth\d?|reauth|authenticate|authentication|authori[sz]e|webauthn|sso|saml|oidc|mfa|2fa|2sv|two-?_?factor|otp|challenge|verify|verification|consent|checkpoint|captcha|password|accountchooser)([./_-]|$)/i;

export function looksLikeSignIn(url) {
  try {
    const u = new URL(url);
    return SIGN_IN_HOST.test(u.hostname) || SIGN_IN_WORD.test(u.hostname + u.pathname);
  } catch {
    return false;
  }
}

// Which page a URL is. Only a hash that routes counts ("#/billing"), not one
// that scrolls. A query change isn't a new page: sign-ins shuffle their state in it.
function pageOf(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname + (/^#[/!]/.test(u.hash) ? u.hash : '');
  } catch {
    return url;
  }
}

// `*` is any run of characters, and the rest is literal (URLs are full of `?`).
// With no `*` it's any part of the URL. A pattern needn't say https://.
export function urlMatches(pattern, url) {
  if (!pattern.includes('*')) return url.includes(pattern);
  const body = pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^(https?://)?${body}$`).test(url);
}

// What --until-url and --until-text ask for, both if both are given.
function describeUntil(untilUrl, untilText) {
  return [untilUrl && `the tab reached ${untilUrl}`, untilText && `"${untilText}" is on the page`].filter(Boolean).join(' and ');
}

// Thrown when what --until asks for is already true on the page the tab was
// handed over on: it can't say when they've finished if it's true before they
// start. Scaleway, 20 Nov: handed over on console.scaleway.com/onboarding with
// --until-url 'https://console.scaleway.com/*', the wait "finished" on its
// first look.
export class UntilAlreadyMet extends Error {}

// see(look, at) takes what the service found (service.mjs, handoffLook) and
// returns why the user is finished, or null if they aren't yet. It throws
// UntilAlreadyMet if --until is true from the start.
export function createHandoffWatch({ untilUrl, untilText, start }) {
  let base = null;
  let left = false;
  let current = null;
  let changedAt = start;
  let firstAt = null;
  let looks = 0;
  let startOver = false;
  let settledStart = false;
  let lastUrl = null;
  let urlAt = start;
  let loadedAt = null;

  return {
    see(look, at) {
      if (look.doneClicked) return 'they clicked Done in the tab';
      if (!base || (base.status !== 'complete' && at - start < BASELINE_MS)) base = look;
      // Handed back: nothing else to wait for, wherever the page has got to.
      if (look.bear && !base.bear) return "they moved it back to BrowserBear's window";

      const here = pageOf(look.url);
      if (here !== current) {
        current = here;
        changedAt = at;
      }
      const quietFor = at - changedAt;
      const loaded = look.status === 'complete' || quietFor >= STILL_LOADING_MS;

      // Asked for something specific: that's the only thing that counts, and
      // with both flags it takes both. Only a yes counts as the text being there.
      if (untilText || untilUrl) {
        const matches = (!untilText || look.text === true) && (!untilUrl || urlMatches(untilUrl, look.url));
        // The start is the page it was handed over on, and any redirect or late
        // drawing it does by itself, not anything they did: at least the first
        // few seconds of looks, and on until one has seen the page loaded, sat
        // still and answered about the text (a probe that can't ask says null).
        // A page that failed to load is waiting on them. Judged on the looks
        // before this one, so the look that ends the start can't also finish it.
        firstAt ??= at;
        looks += 1;
        startOver ||= (at - firstAt >= BASELINE_MS && settledStart) || looks > MAX_START_LOOKS;
        const starting = !startOver;
        // Loaded, by the whole address: a query change is a new page here.
        if (look.url !== lastUrl) {
          lastUrl = look.url;
          urlAt = at;
          loadedAt = null;
          // A redirect during the start has to settle all over again.
          if (starting) settledStart = false;
        }
        const urlLoaded = look.status === 'complete' || at - urlAt >= STILL_LOADING_MS;
        if (urlLoaded && !look.loadError) loadedAt ??= at;
        else loadedAt = null;
        settledStart ||= Boolean(look.loadError) || (loadedAt != null && at - loadedAt >= SETTLE_MS && (!untilText || look.text != null));
        // An address alone is only somewhere once it's loaded (not a hop
        // through it); text on the page is enough to go on.
        const there = matches && (untilText ? true : urlLoaded && !look.loadError);
        if (starting) {
          if (!there) return null;
          const asked = [untilUrl && `--until-url ${untilUrl}`, untilText && `--until-text "${untilText}"`].filter(Boolean).join(' with ');
          throw new UntilAlreadyMet(
            `${asked} is already true on the page the tab was handed over on (${look.url}), so it can't tell when they've finished. ` +
              'The tab is still in front of them. Run it again with something only true once they have: a narrower --until-url, ' +
              '--until-text with words that only show then, both (which must then both be true), or neither (it then waits for the tab to leave this page and settle). ' +
              "If they may have finished already (you're running it again after a timeout, or they were quick), look at the tab.",
          );
        }
        if (!there) return null;
        return describeUntil(untilUrl, untilText);
      }

      const away = here !== pageOf(base.url);
      left ||= away;
      if (look.loadError || !loaded || quietFor < SETTLE_MS) return null;
      if (looksLikeSignIn(look.url) || look.signInForm) return null;
      if (away) return 'the tab left the page it was handed over on';
      // Back where it started, by way of somewhere else: a sign-in that returns you.
      if (left) return 'the tab went away and came back';
      // A sign-in in the page itself, whose address never changes. Strictly
      // false: null means the page couldn't be asked, not that the form went.
      if (base.signInForm && look.signInForm === false) return 'the sign-in form on the page has gone';
      return null;
    },
  };
}
