import { join } from 'path';
import { workflowDir, workflowRunDir, ensureDir, exists, readJson, writeJson, writeText } from './paths.mjs';
import { defaultSafetyPolicy } from './safety.mjs';
import { generateRunReview } from './run-review.mjs';
export { saveRuntimeVars, loadRuntimeVars, resolveTemplate, tryResolveTemplate,
         extractTemplateVars, hasTemplateVars, validateTemplateVars,
         captureVariables, computeDerived,
         filterCapturedByTiming, isFatalCaptureTiming } from './runtime-vars.mjs';

// Load the machine-readable workflow config (workflow.json, created by init:workflow).
// Falls back to safe defaults if file is missing.
export function loadWorkflowConfig(workflowId) {
  const jsonPath = join(workflowDir(workflowId), 'workflow.json');
  if (!exists(jsonPath)) {
    throw new Error(`No workflow.json found for "${workflowId}". Run: npm run init:workflow -- --id ${workflowId}`);
  }
  return readJson(jsonPath);
}

// Load a manifest JSON file.
export function loadManifest(manifestPath) {
  if (!exists(manifestPath)) {
    throw new Error(`Manifest not found: ${manifestPath}\nCreate one or point --manifest at an existing file.`);
  }
  return readJson(manifestPath);
}

// Load safety-policy.json for a workflow, falling back to system defaults.
export function loadSafetyPolicy(workflowId) {
  const policyPath = join(workflowDir(workflowId), 'safety-policy.json');
  if (exists(policyPath)) return readJson(policyPath);
  return defaultSafetyPolicy();
}

// Load field-map.local.json, falling back to field-map.example.json, then empty.
export function loadFieldMap(workflowId) {
  const localPath = join(workflowDir(workflowId), 'field-map.local.json');
  const examplePath = join(workflowDir(workflowId), 'field-map.example.json');
  if (exists(localPath)) return readJson(localPath);
  if (exists(examplePath)) return readJson(examplePath);
  return { fields: {}, notes: 'No field map found. Run discovery and create field-map.local.json.' };
}

// Create a timestamped run directory and return its path.
export function createRunDir(workflowId) {
  const runDir = workflowRunDir(workflowId);
  ensureDir(runDir);
  return runDir;
}

// Create a structured logger that writes to run-log.json on flush().
export function createRunLogger(runDir) {
  const entries = [];

  const log = (level, message, data = {}) => {
    const entry = { timestamp: new Date().toISOString(), level, message, ...data };
    entries.push(entry);
    if (level === 'error') console.error(`[${level.toUpperCase()}] ${message}`);
    else if (level === 'warn') console.warn(`[${level.toUpperCase()}] ${message}`);
    else console.log(`[${level.toUpperCase()}] ${message}`);
    return entry;
  };

  const flush = () => writeJson(join(runDir, 'run-log.json'), entries);

  return { log, flush, entries };
}

// Write a named artifact to the run dir. JSON objects are pretty-printed.
export function writeRunArtifact(runDir, name, data) {
  const path = join(runDir, name);
  if (typeof data === 'string') writeText(path, data);
  else writeJson(path, data);
}

// Save a Playwright page screenshot. Swallows errors and logs them.
export async function saveScreenshot(page, runDir, name) {
  const filename = name.endsWith('.png') ? name : name + '.png';
  const path = join(runDir, filename);
  try {
    await page.screenshot({ path, fullPage: true });
    return path;
  } catch (err) {
    console.warn(`[WARN] Screenshot failed (${filename}): ${err.message}`);
    return null;
  }
}

// Append a filled-field entry to the filled array.
export function recordFilledField(filled, fieldName, selector, value, masked = false) {
  filled.push({
    timestamp: new Date().toISOString(),
    field: fieldName,
    selector,
    value: masked ? '[REDACTED]' : String(value ?? ''),
    masked
  });
}

// Append a skipped-field entry to the skipped array.
export function recordSkippedField(skipped, fieldName, reason, selector = '') {
  skipped.push({ timestamp: new Date().toISOString(), field: fieldName, selector, reason });
}

// Append an error entry to the errors array.
export function recordError(errors, fieldName, errorOrMessage, selector = '') {
  errors.push({
    timestamp: new Date().toISOString(),
    field: fieldName,
    selector,
    error: errorOrMessage instanceof Error ? errorOrMessage.message : String(errorOrMessage)
  });
}

// Write all run artifacts and print a summary to stdout.
// Pass workflowId and startUrl to enable run-review.md generation.
// runtimeVars is an optional object of captured/derived variables from this run.
export function finalizeRun(runDir, { logger, filled = [], skipped = [], errors = [], workflowId = '', startUrl = '', dryRun = true, runtimeVars = null } = {}) {
  writeRunArtifact(runDir, 'filled-fields.json', filled);
  writeRunArtifact(runDir, 'skipped-fields.json', skipped);
  writeRunArtifact(runDir, 'errors.json', errors);
  if (runtimeVars && Object.keys(runtimeVars).length) {
    writeRunArtifact(runDir, 'runtime-vars.json', runtimeVars);
  }
  logger.flush();

  // Generate run-review.md for every run.
  try {
    const review = generateRunReview({ workflowId, runDir, filled, skipped, errors, startUrl, dryRun, runtimeVars });
    writeRunArtifact(runDir, 'run-review.md', review);
  } catch (err) {
    console.warn('[WARN] Could not generate run-review.md: ' + err.message);
  }

  console.log('\n--- Run complete ---');
  console.log('  Artifacts: ' + runDir);
  console.log('  Filled:    ' + filled.length);
  console.log('  Skipped:   ' + skipped.length);
  console.log('  Errors:    ' + errors.length);
  if (errors.length) {
    console.log('\n  Error details:');
    for (const e of errors) console.log(`    [${e.field}] ${e.error}`);
  }
  console.log('\n  run-review.md written — open it to see what happened and what to fix.');
}

// Resolve a dot-path source string against a manifest object.
// e.g. getManifestValue(manifest, 'release.title') → manifest.release.title
export function getManifestValue(manifest, source) {
  if (!source || typeof source !== 'string') return undefined;
  return source.split('.').reduce((acc, key) => acc?.[key], manifest);
}
