// Field-map candidate generator.
// Takes raw discovery output and produces ranked selector candidates
// with stability scores, semantic labels, and match suggestions.

const SEMANTIC_PATTERNS = [
  { pattern: /title|song.?title|track.?title|release.?title/i, label: 'Title field' },
  { pattern: /artist|band.?name|performer/i, label: 'Artist/band name' },
  { pattern: /description|bio|about|notes|summary/i, label: 'Description/notes field' },
  { pattern: /genre|category|type|style/i, label: 'Category/genre selector' },
  { pattern: /language|lang/i, label: 'Language selector' },
  { pattern: /email/i, label: 'Email address' },
  { pattern: /password|passwd/i, label: 'Password field' },
  { pattern: /phone|mobile|tel/i, label: 'Phone number' },
  { pattern: /file|upload|audio|track|attachment|artwork|cover/i, label: 'File upload' },
  { pattern: /submit|send|release|publish|finalize|checkout|pay|purchase/i, label: 'DANGEROUS: final/payment action' },
  { pattern: /legal|certif|agree|terms|acknowledge|confirm/i, label: 'DANGEROUS: legal/certification' },
  { pattern: /paid|upgrade|extra|add.?on|premium|price/i, label: 'DANGEROUS: paid extra/upsell' },
  { pattern: /search|query|find/i, label: 'Search field' },
  { pattern: /next|continue|proceed/i, label: 'Safe navigation button' },
  { pattern: /cancel|back|previous/i, label: 'Navigation button' },
  { pattern: /checkbox|check|select.?all/i, label: 'Checkbox' },
  { pattern: /date|year|month|day/i, label: 'Date field' },
  { pattern: /url|website|link|href/i, label: 'URL/link field' },
  { pattern: /username|user.?name|login|signin/i, label: 'Username/login field' },
];

function inferSemantic(field) {
  const haystack = [
    field.labels || '',
    field.ariaLabel || '',
    field.placeholder || '',
    field.name || '',
    field.id || '',
    field.text || '',
  ].join(' ').toLowerCase();

  for (const { pattern, label } of SEMANTIC_PATTERNS) {
    if (pattern.test(haystack)) return label;
  }
  if (field.tag === 'select') return 'Dropdown selector';
  if (field.tag === 'textarea') return 'Multi-line text field';
  if (field.type === 'file') return 'File upload input';
  if (field.type === 'checkbox') return 'Checkbox';
  if (field.type === 'radio') return 'Radio button';
  if (field.type === 'submit') return 'DANGEROUS: submit button';
  return 'Text input';
}

function isGeneratedId(id) {
  if (!id) return true;
  // IDs with many consecutive numbers are likely generated (e.g. "ember123", "react-select-15-input")
  if (/^\d+$/.test(id)) return true;
  if (/[a-z]+-\d{3,}/.test(id)) return true;
  return false;
}

function selectorCandidates(el) {
  const candidates = [];

  // data-testid and data-* attributes (most stable)
  if (el.dataTestid) {
    candidates.push({ selector: `[data-testid="${el.dataTestid}"]`, stability: 90, method: 'data-testid' });
  }
  for (const [k, v] of Object.entries(el.dataAttrs || {})) {
    candidates.push({ selector: `[${k}="${v}"]`, stability: 80, method: k });
  }

  // aria-label
  if (el.ariaLabel) {
    const tag = el.tag || 'input';
    candidates.push({ selector: `${tag}[aria-label="${el.ariaLabel}"]`, stability: 75, method: 'aria-label' });
  }

  // id-based selector
  if (el.id && !isGeneratedId(el.id)) {
    candidates.push({ selector: `#${CSS_id_safe(el.id)}`, stability: 70, method: 'id' });
  } else if (el.id) {
    candidates.push({ selector: `#${CSS_id_safe(el.id)}`, stability: 40, method: 'id (possibly generated)' });
  }

  // name attribute
  if (el.name) {
    const tag = el.tag || 'input';
    const type = el.type ? `[type="${el.type}"]` : '';
    candidates.push({ selector: `${tag}${type}[name="${el.name}"]`, stability: 65, method: 'name' });
  }

  // label association (already captured in labels field)
  // We note this rather than generate a CSS selector since label text matching requires :has-text or Playwright text

  // placeholder
  if (el.placeholder) {
    const tag = el.tag || 'input';
    candidates.push({ selector: `${tag}[placeholder="${el.placeholder}"]`, stability: 50, method: 'placeholder' });
  }

  // type+index fallback (least stable)
  if (el.type && el.index !== undefined) {
    candidates.push({
      selector: `${el.tag || 'input'}[type="${el.type}"]:nth-of-type(${el.index + 1})`,
      stability: 20,
      method: 'type+index (fragile)'
    });
  }

  // Sort by descending stability
  candidates.sort((a, b) => b.stability - a.stability);
  return candidates;
}

function CSS_id_safe(id) {
  // Escape characters that need escaping in CSS id selectors
  return id.replace(/([!"#$%&'()*+,.\/:;<=>?@[\\\]^`{|}~])/g, '\\$1');
}

function humanLabel(el) {
  if (el.labels) return el.labels;
  if (el.ariaLabel) return el.ariaLabel;
  if (el.placeholder) return el.placeholder;
  if (el.name) return el.name;
  if (el.id) return el.id;
  if (el.text) return el.text;
  return `${el.tag}[${el.index}]`;
}

function mayMatchRequestField(el, requestFields) {
  if (!requestFields || !requestFields.length) return null;
  const elLabel = humanLabel(el).toLowerCase();
  const semantic = inferSemantic(el).toLowerCase();
  for (const rf of requestFields) {
    const fieldName = (rf['field_/_action'] || rf.field || '').toLowerCase().trim();
    if (!fieldName || fieldName.startsWith('(')) continue;
    if (elLabel.includes(fieldName) || fieldName.includes(elLabel) ||
        semantic.includes(fieldName) || fieldName.includes(semantic)) {
      return rf['field_/_action'] || rf.field;
    }
  }
  return null;
}

// Main: generate field-map candidates from discovery data + optional request fields.
export function generateCandidates(discovery, requestFields = []) {
  const elements = [
    ...discovery.inputs.map(el => ({ ...el, _group: 'input' })),
    ...discovery.textareas.map(el => ({ ...el, _group: 'textarea', tag: 'textarea' })),
    ...discovery.selects.map(el => ({ ...el, _group: 'select', tag: 'select' })),
    ...(discovery.fileInputs || []).map(el => ({ ...el, _group: 'file', type: 'file' })),
    ...(discovery.buttons || []).map(el => ({ ...el, _group: 'button', tag: 'button' }))
  ];

  const candidates = elements.map(el => {
    const selectors = selectorCandidates(el);
    return {
      humanLabel: humanLabel(el),
      type: el.type || el.tag || 'unknown',
      tag: el.tag || 'input',
      visible: el.visible,
      likelySemantic: inferSemantic(el),
      isDangerous: inferSemantic(el).startsWith('DANGEROUS'),
      selectorCandidates: selectors,
      recommendedSelector: selectors[0]?.selector || null,
      recommendedStability: selectors[0]?.stability || 0,
      matchesRequestField: mayMatchRequestField(el, requestFields),
      raw: {
        id: el.id || '',
        name: el.name || '',
        ariaLabel: el.ariaLabel || '',
        placeholder: el.placeholder || '',
        labels: el.labels || '',
        text: el.text || '',
        index: el.index
      }
    };
  });

  return {
    url: discovery.url,
    captured_at: discovery.captured_at,
    total: candidates.length,
    dangerous: candidates.filter(c => c.isDangerous).length,
    candidates
  };
}

// Render candidate data as a human-readable markdown document.
export function candidatesMarkdown(data) {
  const lines = [
    '# Browsy Field Map Candidates',
    '',
    `URL: ${data.url}`,
    `Captured: ${data.captured_at}`,
    `Total fields: ${data.total} (${data.dangerous} marked dangerous)`,
    '',
    '> These are selector SUGGESTIONS, not verified selectors.',
    '> Review each entry, pick the best selector, and create field-map.local.json.',
    ''
  ];

  for (const c of data.candidates) {
    lines.push(`## ${c.humanLabel}`);
    lines.push('');
    lines.push(`- **Type:** ${c.type}  `);
    lines.push(`- **Visible:** ${c.visible ? 'yes' : 'no'}  `);
    lines.push(`- **Semantic:** ${c.likelySemantic}${c.isDangerous ? ' ⚠️' : ''}  `);
    if (c.matchesRequestField) lines.push(`- **Matches request field:** \`${c.matchesRequestField}\`  `);
    lines.push('');
    if (c.selectorCandidates.length) {
      lines.push('**Selector candidates:**');
      lines.push('');
      lines.push('| Selector | Method | Stability |');
      lines.push('|---|---|---|');
      for (const s of c.selectorCandidates) {
        lines.push(`| \`${s.selector}\` | ${s.method} | ${s.stability} |`);
      }
      lines.push('');
      lines.push(`**Recommended:** \`${c.recommendedSelector}\` (stability ${c.recommendedStability})`);
    } else {
      lines.push('_No selector candidates could be generated._');
    }
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}
