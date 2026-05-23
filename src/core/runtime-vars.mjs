import { join } from 'path';
import { exists, readJson, writeJson } from './paths.mjs';

// Valid captureAfter timing mode keywords (as opposed to named step IDs).
const CAPTURE_TIMING_MODES = new Set(['initial_navigation', 'each_navigation', 'each_action', 'each_step']);

// Filter a captured-variable spec list to those that should be attempted
// given the current trigger event.
//
// trigger: { event: 'initial_navigation' | 'navigation' | 'action', stepId?: string }
// captureAfter defaults to 'each_step' when not set.
export function filterCapturedByTiming(capturedDefs, trigger) {
  return (capturedDefs || []).filter(def => {
    const timing = def.captureAfter || 'each_step';
    switch (timing) {
      case 'each_step':          return true;
      case 'initial_navigation': return trigger.event === 'initial_navigation';
      case 'each_navigation':    return trigger.event === 'navigation' || trigger.event === 'initial_navigation';
      case 'each_action':        return trigger.event === 'action';
      default:                   return timing === trigger.stepId; // named step ID
    }
  });
}

// Return true if a missing variable with this captureAfter timing should stop
// the run immediately (vs. being retried on a later step).
// Named step IDs and initial_navigation are "strict" — the var had one
// designated opportunity to be captured; if it is still missing, the run
// cannot safely continue.
// each_step / each_action / each_navigation are "lenient" — they keep trying
// and only become fatal when the variable is actually needed (e.g. in a URL template).
export function isFatalCaptureTiming(timing) {
  const t = timing || 'each_step';
  return t === 'initial_navigation' || !CAPTURE_TIMING_MODES.has(t);
}

// Resolve {{varName}} tokens in a template string.
// Throws with the variable name if any token is unresolved.
export function resolveTemplate(template, vars) {
  if (typeof template !== 'string') return template;
  return template.replace(/\{\{([^}]+)\}\}/g, (match, name) => {
    const key = name.trim();
    if (key in vars) return vars[key];
    throw new Error(`Unresolved template variable: {{${key}}}`);
  });
}

// Like resolveTemplate but returns null instead of throwing if a variable is missing.
export function tryResolveTemplate(template, vars) {
  try { return resolveTemplate(template, vars); } catch { return null; }
}

// Return all {{varName}} tokens found in a string as a deduplicated array.
export function extractTemplateVars(template) {
  if (typeof template !== 'string') return [];
  const seen = new Set();
  const re = /\{\{([^}]+)\}\}/g;
  let m;
  while ((m = re.exec(template)) !== null) seen.add(m[1].trim());
  return [...seen];
}

// Return true if the string contains at least one {{...}} token.
export function hasTemplateVars(s) {
  return typeof s === 'string' && /\{\{[^}]+\}\}/.test(s);
}

// Validate that every {{x}} used in the supplied strings is declared in variableDefs.
// variableDefs: { input: [{name}], captured: [{name}], derived: [{name}] }
// Returns array of { context, variable, message } — empty array means all clear.
export function validateTemplateVars(strings, variableDefs = {}) {
  const declared = new Set([
    ...(variableDefs.input    || []).map(v => v.name),
    ...(variableDefs.captured || []).map(v => v.name),
    ...(variableDefs.derived  || []).map(v => v.name),
  ]);
  const issues = [];
  for (const str of strings) {
    for (const varName of extractTemplateVars(str)) {
      if (!declared.has(varName)) {
        issues.push({ context: str, variable: varName, message: `{{${varName}}} is used but not declared in variables` });
      }
    }
  }
  return issues;
}

// Capture a single variable value from a Playwright page object.
// captureSpec: { source, regex, selector, attribute }
// source values: 'current_url' | 'page_text' | 'selector_text' | 'selector_attribute'
// Returns the captured string, or null if not found / regex did not match.
export async function captureFromPage(page, captureSpec) {
  const { source, regex, selector, attribute } = captureSpec;
  let text = '';

  if (source === 'current_url') {
    text = page.url();
  } else if (source === 'page_text') {
    text = await page.locator('body').innerText().catch(() => '');
  } else if (source === 'selector_text' && selector) {
    text = await page.locator(selector).first().innerText().catch(() => '');
  } else if (source === 'selector_attribute' && selector) {
    const attr = attribute || 'value';
    text = (await page.locator(selector).first().getAttribute(attr).catch(() => '')) ?? '';
  }

  if (!text) return null;

  if (regex) {
    const re = new RegExp(regex);
    const match = text.match(re);
    if (!match) return null;
    return match[1] !== undefined ? match[1] : match[0];
  }

  return text;
}

// Capture all variables defined in capturedDefs from the current page state.
// capturedDefs: [{ name, source, regex, selector, attribute, required }]
// vars: existing run-context vars to extend
// Returns { vars: updatedVars, missing: [name, ...] }
export async function captureVariables(page, capturedDefs = [], vars = {}) {
  const updated = { ...vars };
  const missing = [];
  for (const def of capturedDefs) {
    if (!def.name) continue;
    const value = await captureFromPage(page, def);
    if (value !== null && value !== undefined) {
      updated[def.name] = value;
    } else if (def.required !== false) {
      missing.push(def.name);
    }
  }
  return { vars: updated, missing };
}

// Compute derived variables from templates.  Derived vars can reference input,
// captured, or previously computed derived vars.
// derived: [{ name, template }]
// vars: existing vars object
// Returns updated vars object (original is not mutated).
export function computeDerived(derived = [], vars = {}) {
  const result = { ...vars };
  for (const def of derived) {
    if (!def.name || !def.template) continue;
    try {
      result[def.name] = resolveTemplate(def.template, result);
    } catch {
      // Skip: dependency variable not yet captured
    }
  }
  return result;
}

// Persist runtime variables to <runDir>/runtime-vars.json.
export function saveRuntimeVars(runDir, vars) {
  writeJson(join(runDir, 'runtime-vars.json'), vars);
}

// Load runtime variables from <runDir>/runtime-vars.json.
// Returns {} if the file does not exist.
export function loadRuntimeVars(runDir) {
  const path = join(runDir, 'runtime-vars.json');
  if (!exists(path)) return {};
  return readJson(path);
}
