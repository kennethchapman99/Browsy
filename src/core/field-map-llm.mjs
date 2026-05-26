// LLM-powered field mapper — Sprint 1, Direction C.
//
// Takes a package's field list and a discovery candidates set, sends a single
// structured LLM request, and returns { fieldMap, unmapped, confidence }.
//
// Hallucination guard: every selector returned by the LLM must appear in
// the known selectorCandidates set. Unknown selectors → unmapped[].
//
// Provider abstraction: pass any `callLLM(messages, systemPrompt) → string`
// function. Use makeAnthropicCaller() for the real Anthropic API, or pass a
// mock in tests.

// ---------------------------------------------------------------------------
// extractPackageFields — derive typed field list from a package JSON
// ---------------------------------------------------------------------------

// Returns [{ fieldName, inputType, scope, groupId?, sourcePath, label }]
export function extractPackageFields(pkg) {
  const fields = [];

  // Source the field-bearing buckets from either the current contract shape
  // (pkg.canonical_payload.{globals|defaults|repeatGroups|capturedOutputs} +
  // assets-as-keyed-object kept in canonical_payload for mapping) or the legacy
  // flat shape (pkg.globals/.assets/...). Top-level keys win when both are present.
  const cp = (pkg.canonical_payload && typeof pkg.canonical_payload === 'object' && !Array.isArray(pkg.canonical_payload))
    ? pkg.canonical_payload
    : {};
  const globals = (pkg.globals && typeof pkg.globals === 'object' && !Array.isArray(pkg.globals))
    ? pkg.globals : (cp.globals || {});
  // pkg.assets in the new contract is an array; only treat it as the legacy
  // id→path object when it actually is one. Otherwise fall back to canonical_payload.
  const assetsObj = (pkg.assets && typeof pkg.assets === 'object' && !Array.isArray(pkg.assets))
    ? pkg.assets : (cp.assets || {});
  const defaults = (pkg.defaults && typeof pkg.defaults === 'object' && !Array.isArray(pkg.defaults))
    ? pkg.defaults : (cp.defaults || {});
  const repeatGroups = Array.isArray(pkg.repeatGroups) ? pkg.repeatGroups : (cp.repeatGroups || []);
  const capturedOutputs = Array.isArray(pkg.capturedOutputs) ? pkg.capturedOutputs : (cp.capturedOutputs || []);

  // Global text fields
  for (const [key, val] of Object.entries(globals)) {
    fields.push({
      fieldName: key,
      inputType: 'text',
      scope: 'global',
      sourcePath: `globals.${key}`,
      label: typeof val === 'object' && val?.label ? val.label : key,
    });
  }

  // Global file uploads
  for (const [key, val] of Object.entries(assetsObj)) {
    fields.push({
      fieldName: key,
      inputType: 'file',
      scope: 'asset',
      sourcePath: `assets.${key}`,
      label: typeof val === 'object' && val?.label ? val.label : key,
    });
  }

  // Default values (applied as fallback to repeat items — still real form fields)
  for (const [key, val] of Object.entries(defaults)) {
    // Avoid duplicating a key already captured from globals or assets
    if (!fields.some(f => f.fieldName === key)) {
      fields.push({
        fieldName: key,
        inputType: 'text',
        scope: 'default',
        sourcePath: `defaults.${key}`,
        label: key,
      });
    }
  }

  // Repeat group items
  for (const group of repeatGroups) {
    const groupId = group.id || 'items';
    const sample = group.items?.[0] || {};
    for (const [key, val] of Object.entries(sample.fields || {})) {
      fields.push({
        fieldName: key,
        inputType: 'text',
        scope: 'item',
        groupId,
        sourcePath: `repeatGroups.${groupId}.items[].fields.${key}`,
        label: typeof val === 'object' && val?.label ? val.label : key,
      });
    }
    for (const [key, val] of Object.entries(sample.assets || {})) {
      fields.push({
        fieldName: key,
        inputType: 'file',
        scope: 'item_asset',
        groupId,
        sourcePath: `repeatGroups.${groupId}.items[].assets.${key}`,
        label: typeof val === 'object' && val?.label ? val.label : key,
      });
    }
  }

  // Captured outputs — informational, not fillable by the executor,
  // but included so LLM mapping can flag external link targets.
  for (const output of capturedOutputs) {
    const id = output.id || output.name;
    if (!id) continue;
    fields.push({
      fieldName: id,
      inputType: 'captured',
      scope: output.scope || 'captured',
      sourcePath: `capturedOutputs.${id}`,
      label: output.label || id,
    });
  }

  return fields;
}

// ---------------------------------------------------------------------------
// Build known-selector set for hallucination guard
// ---------------------------------------------------------------------------

function buildKnownSelectors(candidates) {
  const known = new Set();
  for (const c of candidates) {
    for (const sc of c.selectorCandidates || []) {
      if (sc.selector) known.add(sc.selector);
    }
    if (c.recommendedSelector) known.add(c.recommendedSelector);
  }
  return known;
}

// ---------------------------------------------------------------------------
// Build compact candidate list for the LLM prompt
// ---------------------------------------------------------------------------

function compactCandidates(candidates) {
  // Drop dangerous elements — we never want the LLM mapping to them
  const safe = candidates.filter(c => !c.isDangerous);

  return safe.map(c => ({
    label:    c.humanLabel,
    semantic: c.likelySemantic,
    type:     c.type,
    visible:  c.visible,
    // Top 3 selectors only (keep prompt compact)
    selectors: (c.selectorCandidates || []).slice(0, 3).map(s => ({
      sel:       s.selector,
      stability: s.stability,
      method:    s.method,
    })),
  }));
}

// ---------------------------------------------------------------------------
// mapFieldsWithLLM — core function
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a browser automation expert. You will receive:
1. A list of form fields the user wants to fill (packageFields)
2. A list of DOM elements discovered on the target page (candidates)

Your job: for each package field, find the best matching DOM selector from the candidates.

Rules:
- ONLY use selector values that appear verbatim in the candidates list. Never invent selectors.
- Prefer higher stability scores (90=data-testid, 80=data-attr, 75=aria-label, 70=id, 65=name).
- If no confident match exists, set selector to null.
- For file-upload fields (inputType=file), only match candidates with type="file".
- Never map to dangerous elements (buttons with submit/pay/release labels).

Respond with ONLY valid JSON — no markdown fences, no explanation:
{
  "mappings": [
    { "fieldName": "<fieldName>", "selector": "<selector or null>", "confidence": <0.0–1.0>, "reasoning": "<one short sentence>" }
  ]
}`;

export async function mapFieldsWithLLM({ packageFields, candidates, callLLM }) {
  if (!packageFields || packageFields.length === 0) {
    return { fieldMap: {}, unmapped: [], confidence: {} };
  }

  const knownSelectors = buildKnownSelectors(candidates);
  const compactCands   = compactCandidates(candidates);

  const userMessage = JSON.stringify({
    packageFields: packageFields.map(f => ({
      fieldName: f.fieldName,
      inputType: f.inputType,
      scope:     f.scope,
    })),
    candidates: compactCands,
  }, null, 2);

  const rawResponse = await callLLM(
    [{ role: 'user', content: userMessage }],
    SYSTEM_PROMPT
  );

  // Parse response
  let parsed;
  try {
    // Strip accidental markdown fences if present
    const cleaned = rawResponse.replace(/^```[a-z]*\n?/m, '').replace(/\n?```$/m, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`field-map-llm: LLM returned invalid JSON — ${err.message}\nRaw: ${rawResponse.slice(0, 300)}`);
  }

  const mappings = parsed.mappings || [];

  // Build output, applying hallucination guard
  const fieldMap  = {};
  const unmapped  = [];
  const confidence = {};

  for (const m of mappings) {
    const { fieldName, selector, confidence: conf } = m;
    if (!fieldName) continue;

    if (!selector) {
      unmapped.push(fieldName);
      confidence[fieldName] = 0;
    } else if (!knownSelectors.has(selector)) {
      // LLM invented a selector — treat as unmapped rather than write a broken selector
      unmapped.push(fieldName);
      confidence[fieldName] = 0;
    } else {
      const pkgField = packageFields.find(f => f.fieldName === fieldName);
      fieldMap[fieldName] = {
        selector,
        type:   pkgField?.inputType || 'text',
        source: 'llm',
      };
      confidence[fieldName] = typeof conf === 'number' ? Math.min(1, Math.max(0, conf)) : 0.5;
    }
  }

  // Any packageField the LLM didn't mention → unmapped
  for (const f of packageFields) {
    if (!fieldMap[f.fieldName] && !unmapped.includes(f.fieldName)) {
      unmapped.push(f.fieldName);
    }
  }

  return { fieldMap, unmapped, confidence };
}

// ---------------------------------------------------------------------------
// makeAnthropicCaller — real Anthropic API callLLM factory
// ---------------------------------------------------------------------------

export function makeAnthropicCaller({
  apiKey,
  model = 'claude-haiku-4-5-20251001',
} = {}) {
  return async function callLLM(messages, systemPrompt) {
    // Lazy import so tests without the SDK still work
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: apiKey ?? process.env.ANTHROPIC_API_KEY });

    const response = await client.messages.create({
      model,
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    });

    return response.content?.[0]?.text ?? '';
  };
}
