// Generic auth-preflight rule evaluation.
//
// Browsy owns the browser; the embedding app owns which URLs/text
// mean "not authenticated" for a given workflow. The app passes generic rules in
// the recording setup / preflight request; this module evaluates observed page
// facts (final URL, title, body text) against those rules. No site-specific or
// provider-specific logic lives here — only a small generic matcher.

// Sensible defaults so a preflight without explicit rules still catches the
// common "automation browser bounced to an SSO/login page" states. Apps should
// pass their own rules for precise control.
export const DEFAULT_AUTH_PREFLIGHT_RULES = Object.freeze([
  { code: 'auth_required', when: 'urlIncludes', value: 'accounts.google.com' },
  { code: 'auth_required', when: 'urlIncludes', value: '/signin' },
  { code: 'auth_required', when: 'urlIncludes', value: '/login' },
  { code: 'auth_required', when: 'textIncludes', value: "couldn't sign you in" },
  { code: 'auth_required', when: 'textIncludes', value: 'couldn’t sign you in' },
  { code: 'auth_required', when: 'textIncludes', value: 'this browser or app may not be secure' },
]);

function messageFor(code, finalUrl) {
  if (/google/i.test(String(finalUrl || '')) || code === 'auth_rejected') {
    return 'Sign-in was rejected in the automation browser (Google "this browser or app may not be secure"). Open the auth browser and sign in once with the persistent Chrome profile.';
  }
  return 'Target requires authentication — the persistent profile is not signed in yet. Open the auth browser and sign in once, then retry.';
}

// Evaluate a single set of observed page facts against generic rules.
// Returns { ok, code, matchedRule, message }. ok=true means authenticated.
export function evaluateAuthPreflight({ targetUrl, finalUrl, title = '', bodyText = '', rules } = {}) {
  const activeRules = Array.isArray(rules) && rules.length ? rules : DEFAULT_AUTH_PREFLIGHT_RULES;
  const url = String(finalUrl || '').toLowerCase();
  const text = `${String(title || '')}\n${String(bodyText || '')}`.toLowerCase();
  for (const rule of activeRules) {
    const value = String(rule?.value || '').toLowerCase();
    if (!value) continue;
    const when = String(rule?.when || 'urlIncludes');
    let matched = false;
    if (when === 'urlIncludes') matched = url.includes(value);
    else if (when === 'urlEquals') matched = url === value;
    else if (when === 'textIncludes' || when === 'bodyIncludes' || when === 'titleIncludes') matched = text.includes(value);
    if (matched) {
      const code = rule.code || 'auth_required';
      return { ok: false, code, matchedRule: { when, value: rule.value }, message: messageFor(code, finalUrl) };
    }
  }
  return { ok: true, code: 'authenticated', matchedRule: null, message: 'Authenticated session detected — preflight passed.' };
}
