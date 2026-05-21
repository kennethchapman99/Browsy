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
  'Save and submit',
  'Send to stores',
  'Delete'
];

export function normalizeText(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function isDangerousText(text, policy = {}) {
  const haystack = normalizeText(text);
  if (!haystack) return false;
  const checks = [...DEFAULT_DANGEROUS_TEXT, ...(policy.never_click_text || [])];
  return checks.some(item => {
    const needle = normalizeText(item);
    return needle && haystack.includes(needle);
  });
}

export async function safeClick(locator, label, policy = {}) {
  if (isDangerousText(label, policy)) {
    throw new Error('Blocked dangerous click: ' + label);
  }
  await locator.click();
}

export function defaultSafetyPolicy() {
  return {
    dry_run_default: true,
    pause_at_end_default: true,
    never_click_text: DEFAULT_DANGEROUS_TEXT,
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
