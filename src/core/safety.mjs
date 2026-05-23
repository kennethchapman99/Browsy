// Safety primitives for Browsy automation harnesses.
// All dangerous-action detection should go through these functions so behavior
// is testable and explicit.

export const DEFAULT_DANGEROUS_TEXT = [
  'Submit',
  'Finalize',
  'Release',
  'Pay',
  'Purchase',
  'Checkout',
  'Confirm order',
  'Upload to stores',
  'Continue & submit',
  'Continue and submit',
  'Save and submit',
  'Send to stores',
  'Send',
  'Delete',
  'Remove',
  'Publish',
];

// Text patterns that suggest legal attestation checkboxes.
export const LEGAL_ATTESTATION_PATTERNS = [
  /i (agree|certify|confirm|attest|acknowledge)/i,
  /terms (of service|and conditions)/i,
  /privacy policy/i,
  /by (checking|clicking|selecting) (this|here)/i,
  /legal/i,
  /certif/i,
  /acknowledge/i,
];

// Text patterns that suggest payment/purchase actions.
export const PAYMENT_PATTERNS = [
  /pay(ment)?/i,
  /purchase/i,
  /checkout/i,
  /credit card/i,
  /billing/i,
  /subscribe/i,
  /upgrade/i,
  /add.?on/i,
  /\bpaid\b/i,
];

// Text patterns that suggest destructive actions.
export const DESTRUCTIVE_PATTERNS = [
  /\bdelete\b/i,
  /\bremove\b/i,
  /\bdestroy\b/i,
  /\bwipe\b/i,
  /\bpurge\b/i,
  /\btruncate\b/i,
];

export function normalizeText(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Return true if text matches any dangerous action pattern.
export function isDangerousText(text, policy = {}) {
  const haystack = normalizeText(text);
  if (!haystack) return false;
  const checks = [...DEFAULT_DANGEROUS_TEXT, ...(policy.never_click_text || [])];
  return checks.some(item => {
    const needle = normalizeText(item);
    return needle && haystack.includes(needle);
  });
}

// Return true if a CSS selector matches any blocked selector in the policy.
export function isSelectorBlocked(selector, policy = {}) {
  if (!selector || !policy.never_click_selectors?.length) return false;
  return policy.never_click_selectors.some(blocked => selector === blocked || selector.includes(blocked));
}

// Return true if label text matches legal attestation patterns.
export function isLegalAttestation(text) {
  const haystack = normalizeText(text);
  return LEGAL_ATTESTATION_PATTERNS.some(p => p.test(haystack));
}

// Return true if label text matches payment/purchase patterns.
export function isPaymentAction(text) {
  const haystack = normalizeText(text);
  return PAYMENT_PATTERNS.some(p => p.test(haystack));
}

// Return true if label text matches destructive action patterns.
export function isDestructiveAction(text) {
  const haystack = normalizeText(text);
  return DESTRUCTIVE_PATTERNS.some(p => p.test(haystack));
}

// Return true if a field's safety_category is in the policy's manual_only_categories list.
export function isManualOnly(safetyCategory, policy = {}) {
  if (!safetyCategory) return false;
  const cats = (policy.manual_only_categories || []).map(c => normalizeText(c));
  return cats.includes(normalizeText(safetyCategory));
}

// Classify a piece of label text and return a safety category or null.
export function classifyText(text) {
  if (isDangerousText(text)) return 'final submission';
  if (isLegalAttestation(text)) return 'legal certification';
  if (isPaymentAction(text)) return 'payment';
  if (isDestructiveAction(text)) return 'destructive action';
  return null;
}

// Attempt a safe click: throws if the label is dangerous or selector is blocked.
// Returns the locator for chaining.
export async function safeClick(locator, label, policy = {}) {
  if (isDangerousText(label, policy)) {
    throw new Error('Blocked dangerous click: ' + label);
  }
  await locator.click();
  return locator;
}

export function defaultSafetyPolicy() {
  return {
    dry_run_default: true,
    pause_at_end_default: true,
    never_click_text: [...DEFAULT_DANGEROUS_TEXT],
    never_click_selectors: [],
    manual_only_categories: [
      'legal certification',
      'payment',
      'purchase',
      'paid extras',
      'final submission',
      'destructive action'
    ]
  };
}
