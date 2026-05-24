import fs from 'fs';
import { join } from 'path';
import { REPO_ROOT } from './paths.mjs';

const PLACEHOLDER_NAMES = new Set(['my-workflow', 'workflow-name', 'template-workflow', 'example-workflow']);
const PLACEHOLDER_GOALS = ['fill in the goal','describe the automation goal here','example goal','goal here','(goal)','todo'];

// Parse AUTOMATION_REQUEST.md into a structured object.
// Returns { ...fields, validationIssues: [{ level, field, message, fix }] }
export function parseRequest(text) {
  const sections = splitSections(text);

  const workflowName = extractWorkflowName(sections['1. Workflow name'] || '');
  const goal = extractGoal(sections['2. Goal'] || '');
  const targetUrls = extractTableRows(sections['3. Target websites / pages'] || '');

  const sec4 = sections['4. Existing APIs, files, or local systems'] || sections['4. Existing APIs or local systems'] || '';
  const dataSources = extractJsonBlockSafe(sec4);
  const apis = dataSources.value && Array.isArray(dataSources.value) ? dataSources.value : extractTableRows(sec4);

  const inputDataContract = extractJsonBlock(sections['5. Input data contract'] || '');
  const runtimeVariablesResult = extractJsonBlockSafe(sections['5a. Runtime variables'] || '');
  const repeatGroupsResult = extractJsonBlockSafe(sections['5b. Repeat groups'] || '');
  const capturedOutputsResult = extractJsonBlockSafe(
    sections['5c. Captured outputs'] ||
    sections['5c. External links and captured outputs'] ||
    sections['5c. External links / captured outputs'] ||
    ''
  );
  const gatesResult = extractJsonBlockSafe(sections['5d. Gates'] || sections['5d. Downstream gates'] || '');
  const observationRequirementsResult = extractJsonBlockSafe(
    sections['5e. Observation requirements'] ||
    sections['17. Observation plan'] ||
    sections['16a. Observation plan'] ||
    ''
  );

  const desiredSteps = extractListItems(sections['6. Desired workflow steps'] || '');
  const fieldsActions = extractTableRows(sections['7. Fields to fill or upload'] || '');
  const manualOnlyActions = extractListItems(sections['8. Actions that must stay manual'] || '');
  const humanCheckpoints = extractListItems(sections['9. Human checkpoints'] || '');
  const authMode = extractAuthMode(sections['10. Authentication plan'] || '');
  const discoveryNeeds = extractDiscoveryUrls(sections['11. Discovery needs'] || '');
  const safetyPolicyResult = extractJsonBlockSafe(sections['12. Safety policy'] || '');
  const outputArtifacts = extractListItems(sections['13. Output artifacts expected'] || '');
  const testCommands = extractCodeBlockText(sections['14. Test commands expected'] || '');
  const acceptanceCriteria = extractListItems(sections['15. Acceptance criteria'] || '');
  const walkthroughText = (sections['16. Narrated walkthrough'] || '').trim();

  const workflowId = toWorkflowId(workflowName);
  const runtimeVariables = runtimeVariablesResult.value || { input: [], captured: [], derived: [] };
  const repeatGroups = repeatGroupsResult.value?.repeatGroups || [];
  const capturedOutputs = normalizeCapturedOutputs({
    capturedOutputsBlock: capturedOutputsResult.value,
    runtimeVariables,
    fieldsActions,
    inputDataContract,
  });
  const externalLinks = capturedOutputs.filter(output => output.scope === 'external_link');
  const gates = normalizeGates(gatesResult.value?.gates || gatesResult.value || []);
  const observationRequirements = normalizeObservationRequirements(observationRequirementsResult.value);

  const issues = validate({
    workflowName, workflowId, goal, targetUrls, fieldsActions,
    manualOnlyActions, safetyPolicyResult, acceptanceCriteria, walkthroughText,
    runtimeVariables, repeatGroups, inputDataContract, capturedOutputs, gates,
    observationRequirements,
  });

  return {
    workflowId,
    workflowName,
    goal,
    targetUrls,
    apis,
    dataSources: Array.isArray(apis) ? apis : [],
    inputDataContract,
    runtimeVariables,
    repeatGroups,
    capturedOutputs,
    externalLinks,
    gates,
    observationRequirements,
    desiredSteps,
    fieldsActions,
    manualOnlyActions,
    humanCheckpoints,
    authMode,
    discoveryNeeds,
    safetyPolicy: safetyPolicyResult.value,
    safetyPolicyError: safetyPolicyResult.error,
    outputArtifacts,
    testCommands,
    acceptanceCriteria,
    walkthroughText,
    validationIssues: issues,
  };
}

export function loadAndParseRequest() {
  const path = join(REPO_ROOT, 'AUTOMATION_REQUEST.md');
  if (!fs.existsSync(path)) throw new Error('AUTOMATION_REQUEST.md not found at ' + path);
  return parseRequest(fs.readFileSync(path, 'utf8'));
}

function splitSections(text) {
  const result = {};
  const lines = text.split('\n');
  let currentKey = null;
  const buffer = [];
  for (const line of lines) {
    const m = line.match(/^##\s+(\d+[a-z]?\.\s*.+)$/i);
    if (m) {
      if (currentKey !== null) result[currentKey] = buffer.join('\n').trim();
      currentKey = m[1].trim();
      buffer.length = 0;
    } else if (currentKey !== null) {
      buffer.push(line);
    }
  }
  if (currentKey !== null) result[currentKey] = buffer.join('\n').trim();
  return result;
}

function extractWorkflowName(text) {
  const backtick = text.match(/`([^`]+)`/);
  if (backtick) return backtick[1].trim();
  const line = text.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#'));
  return (line || '').replace(/[`'"]/g, '').trim();
}

function extractGoal(text) { return text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')).join(' ').trim(); }
function extractAuthMode(text) { const line = text.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#')); return (line || '').replace(/^[-*]\s*/, '').trim() || 'manual-save-state'; }
function extractListItems(text) { return text.split('\n').map(l => l.trim()).filter(l => /^[-*\d]/.test(l)).map(l => l.replace(/^[-*]\s*/, '').replace(/^\d+\.\s*/, '').trim()).filter(Boolean); }

function extractTableRows(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.startsWith('|'));
  if (lines.length < 3) return [];
  const parseRow = l => l.split('|').slice(1, -1).map(c => c.trim());
  const headers = parseRow(lines[0]).map(h => h.toLowerCase().replace(/[\s/?()?]+/g, '_').replace(/_+$/, ''));
  return lines.slice(2).map(row => {
    const cells = parseRow(row);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = cells[i] ?? ''; });
    return obj;
  }).filter(row => Object.values(row).some(v => v));
}

function extractJsonBlock(text) { const m = text.match(/```(?:json)?\s*\n([\s\S]*?)```/); if (!m) return null; try { return JSON.parse(m[1].trim()); } catch { return null; } }
function extractJsonBlockSafe(text) { const m = text.match(/```(?:json)?\s*\n([\s\S]*?)```/); if (!m) return { value: null, error: 'No JSON code block found' }; try { return { value: JSON.parse(m[1].trim()), error: null }; } catch (e) { return { value: null, error: e.message }; } }
function extractCodeBlockText(text) { const m = text.match(/```(?:\w+)?\s*\n([\s\S]*?)```/); return m ? m[1].trim() : ''; }

function extractDiscoveryUrls(text) {
  const urls = [];
  for (const line of text.split('\n').map(l => l.trim())) {
    const urlMatch = line.match(/https?:\/\/\S+/);
    if (urlMatch) urls.push(urlMatch[0].replace(/[.,;)]+$/, ''));
  }
  return urls;
}

function toWorkflowId(name) { return String(name || '').toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '') || 'workflow'; }
function toCamel(str) { return String(str || '').replace(/`/g, '').trim().replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean).map((part, i) => { const lower = part.toLowerCase(); return i === 0 ? lower : lower.charAt(0).toUpperCase() + lower.slice(1); }).join(''); }

function normalizeCapturedOutputs({ capturedOutputsBlock, runtimeVariables, fieldsActions, inputDataContract }) {
  const outputs = [];
  const blockItems = Array.isArray(capturedOutputsBlock?.capturedOutputs)
    ? capturedOutputsBlock.capturedOutputs
    : Array.isArray(capturedOutputsBlock) ? capturedOutputsBlock : [];

  for (const item of blockItems) pushOutput(outputs, item, item.source || 'captured_from_page');

  for (const item of runtimeVariables?.captured || []) {
    pushOutput(outputs, {
      ...item,
      id: item.id || item.name,
      label: item.label || item.name,
      scope: item.scope || inferOutputScope(item.name || item.label || item.id),
    }, item.source || 'captured_from_page');
  }

  for (const row of fieldsActions || []) {
    const scopeText = `${row.scope_rule || row.scope || ''} ${row.field_action || ''} ${row.source_in_input || ''}`.toLowerCase();
    if (!/(captured|external link|output only|public url|confirmation|generated page|assigned id)/.test(scopeText)) continue;
    pushOutput(outputs, {
      id: row.source_in_input || row.field_action || row.field || 'captured output',
      label: row.field_action || row.field || row.source_in_input,
      scope: normalizeOutputScope(scopeText),
      required: !/optional|not required/.test(scopeText),
      verify: /verified|public url|external link/.test(scopeText) ? { type: 'manual_or_http_status' } : null,
    }, 'fields_table');
  }

  for (const key of Object.keys(inputDataContract?.captured || {})) {
    pushOutput(outputs, { id: key, label: key, scope: inferOutputScope(key), required: true }, 'input_contract.captured');
  }

  const byId = new Map();
  for (const output of outputs) byId.set(output.id, output);
  return [...byId.values()];
}

function pushOutput(outputs, item, defaultSource) {
  if (!item) return;
  const id = toCamel(item.id || item.name || item.label);
  if (!id) return;
  outputs.push({
    id,
    label: item.label || item.name || id,
    scope: normalizeOutputScope(item.scope),
    source: item.source || defaultSource,
    required: item.required !== false,
    verify: item.verify || null,
    storesTo: item.storesTo || `captured.${id}`,
  });
}

function normalizeOutputScope(scope = '') {
  const s = String(scope).toLowerCase().replace(/[-\s]+/g, '_');
  if (s.includes('external') || s.includes('public_url') || s.includes('link')) return 'external_link';
  if (s.includes('derived')) return 'derived';
  if (s.includes('output')) return 'output_only';
  return 'captured';
}
function inferOutputScope(value = '') { return /url|link|public|page/i.test(String(value)) ? 'external_link' : 'captured'; }
function normalizeGates(value) { return (Array.isArray(value) ? value : []).map(gate => ({ id: gate.id || toWorkflowId(gate.label || 'gate'), label: gate.label || gate.id || 'Gate', requires: Array.isArray(gate.requires) ? gate.requires : [], unlocks: Array.isArray(gate.unlocks) ? gate.unlocks : [], mode: gate.mode || 'all', description: gate.description || '' })); }
function normalizeObservationRequirements(value) { return value && typeof value === 'object' ? { atlasObservationNeeded: value.atlasObservationNeeded !== false, pages: Array.isArray(value.pages) ? value.pages : [], requiredStates: Array.isArray(value.requiredStates) ? value.requiredStates : [], artifacts: Array.isArray(value.artifacts) ? value.artifacts : [], notes: value.notes || '' } : { atlasObservationNeeded: false, requiredStates: [], artifacts: [], notes: '' }; }

function extractTemplateVarsFromString(s) { const seen = new Set(); const re = /\{\{([^}]+)\}\}/g; let m; while ((m = re.exec(s)) !== null) seen.add(m[1].trim()); return [...seen]; }
function isPlaceholderGoal(goal) { const lower = goal.toLowerCase(); return !goal || PLACEHOLDER_GOALS.some(p => lower.includes(p)); }
function isPlaceholderWalkthrough(text) { return !text || text.startsWith('(') || text.toLowerCase().includes('no walkthrough') || text.toLowerCase().includes('wizard'); }
function isPlaceholderFieldsTable(rows) { return !rows.length || rows.every(row => Object.values(row).some(v => String(v).startsWith('('))); }

function validate({ workflowName, workflowId, goal, targetUrls, fieldsActions, manualOnlyActions, safetyPolicyResult, acceptanceCriteria, walkthroughText, runtimeVariables, repeatGroups = [], inputDataContract, capturedOutputs = [], gates = [], observationRequirements }) {
  const issues = [];
  const err = (field, message, fix) => issues.push({ level: 'error', field, message, fix });
  const warn = (field, message, fix) => issues.push({ level: 'warning', field, message, fix });

  if (!workflowName) err('workflow_name', 'Workflow name is missing.', 'Add a backtick-wrapped name under ## 1. Workflow name, e.g. `my-workflow`.');
  else if (PLACEHOLDER_NAMES.has(workflowId)) err('workflow_name', `Workflow name "${workflowName}" looks like a placeholder.`, 'Replace with a descriptive name for your specific workflow.');
  if (!goal) err('goal', 'Goal is empty.', 'Describe what the automation should accomplish under ## 2. Goal.');
  else if (isPlaceholderGoal(goal)) warn('goal', 'Goal may be placeholder text.', 'Replace with a real description of the automation objective.');
  if (!targetUrls.some(r => (r.url || '').startsWith('http'))) err('target_urls', 'No target URLs found in ## 3. Target websites / pages.', 'Add at least one row with a URL. Browser automation requires a target page.');
  if (isPlaceholderFieldsTable(fieldsActions)) warn('fields_actions', '## 7. Fields to fill or upload contains no real fields yet.', 'Run discovery first: npm run discover -- --workflow <id> --url <url>. Then populate this table from the candidates.');
  if (!manualOnlyActions.length) err('manual_only_actions', '## 8. Actions that must stay manual is empty.', 'List the actions that must never be automated (submit, payment, legal, etc.).');

  if (safetyPolicyResult.error) err('safety_policy', `## 12. Safety policy JSON is invalid: ${safetyPolicyResult.error}`, 'Fix the JSON in the safety policy code block. It must be valid JSON with at minimum a "never_click_text" array.');
  else if (!safetyPolicyResult.value) err('safety_policy', '## 12. Safety policy has no JSON code block.', 'Add a ```json block with your safety policy under ## 12.');
  else if (!Array.isArray(safetyPolicyResult.value?.never_click_text)) warn('safety_policy', 'Safety policy is missing "never_click_text" array.', 'Add "never_click_text": ["Submit", "Pay", ...] to the safety policy JSON.');

  if (!acceptanceCriteria.length) err('acceptance_criteria', '## 15. Acceptance criteria is empty.', 'List at least the key things that must be true for this automation to be considered working.');
  if (isPlaceholderWalkthrough(walkthroughText)) warn('walkthrough', '## 16. Narrated walkthrough is empty or placeholder.', 'Run the Browsy wizard (npm run wizard) to record a walkthrough, or write one manually.');

  if (runtimeVariables) {
    const declaredNames = new Set([...(runtimeVariables.input || []).map(v => v.name), ...(runtimeVariables.captured || []).map(v => v.name), ...(runtimeVariables.derived || []).map(v => v.name)]);
    for (const url of targetUrls.map(r => r.url || '').filter(Boolean)) {
      for (const varName of extractTemplateVarsFromString(url)) {
        if (!declaredNames.has(varName)) err('runtime_variables', `URL template uses {{${varName}}} but it is not declared in ## 5a. Runtime variables.`, `Add "${varName}" to the input, captured, or derived list in ## 5a. Runtime variables.`);
      }
    }
  }

  for (const rg of repeatGroups) validateRepeatGroup(rg, inputDataContract, warn);
  validateGates(gates, capturedOutputs, warn);
  if (observationRequirements?.atlasObservationNeeded && !observationRequirements.requiredStates?.length) warn('observation', 'Atlas observation is marked needed but no page states are listed.', 'List states such as blank form, validation error, repeated item added, review page, success page.');
  return issues;
}

function validateRepeatGroup(rg, inputDataContract, warn) {
  if (!rg.name) warn('repeat_groups', 'A repeat group is missing a name.', 'Add a "name" field to each repeat group in ## 5b. Repeat groups.');
  if (!rg.itemName) warn('repeat_groups', `Repeat group "${rg.name || '(unnamed)'}" is missing an item name.`, 'Add an "itemName" (singular noun, e.g. "track") to the repeat group.');
  if (!rg.source) warn('repeat_groups', `Repeat group "${rg.name || '(unnamed)'}" has no source array declared.`, 'Set "source" to the path of the array in the manifest (e.g. "tracks[]").');
  else {
    const sourceKey = rg.source.replace(/\[\]$/, '').split('.')[0];
    const contractHasKey = inputDataContract && typeof inputDataContract === 'object' && (sourceKey in inputDataContract);
    if (!contractHasKey) warn('repeat_groups', `Repeat group "${rg.name}" source "${rg.source}" key "${sourceKey}" is not declared in ## 5. Input data contract.`, `Add a "${sourceKey}" array to the input data contract, or mark it as inferred from a data source.`);
  }
  if (!rg.itemFields || rg.itemFields.length === 0) warn('repeat_groups', `Repeat group "${rg.name || '(unnamed)'}" has no item fields.`, 'Add "itemFields" listing the fields that fill once per item.');
  for (const f of (rg.itemFields || [])) {
    const fieldName = typeof f === 'string' ? f : f.name;
    const source = typeof f === 'string' ? f : f.source;
    if (source && rg.itemName && !source.startsWith(rg.itemName)) warn('repeat_groups', `Repeat group "${rg.name}" item field "${fieldName}" source "${source}" does not start with item name "${rg.itemName}".`, `Use "${rg.itemName}.<fieldName>" as the source for item-scoped fields.`);
  }
  if (rg.itemName) {
    const itemPrefix = rg.itemName + '.';
    for (const fieldSource of (rg.globalFields || [])) {
      if (typeof fieldSource === 'string' && fieldSource.startsWith(itemPrefix)) warn('repeat_groups', `Repeat group "${rg.name}" global field "${fieldSource}" starts with item alias "${rg.itemName}" — global fields must not reference per-item data.`, `Move "${fieldSource}" to "itemFields", or change its source to a non-item path.`);
    }
  }
  if (!rg.repeatAction) warn('repeat_groups', `Repeat group "${rg.name || '(unnamed)'}" has no "repeatAction" defined.`, 'Add a "repeatAction" object with at minimum { "type": "click", "description": "..." } so the executor knows how to add new sections.');
}

function validateGates(gates, capturedOutputs, warn) {
  const capturedIds = new Set(capturedOutputs.map(output => output.id));
  for (const gate of gates) {
    if (!gate.requires.length) warn('gates', `Gate "${gate.id}" has no requirements.`, 'Add at least one requirement like "captured.publicUrl" or "checks.publicUrl.status == verified".');
    if (!gate.unlocks.length) warn('gates', `Gate "${gate.id}" unlocks no downstream stage.`, 'Add unlocks like "outreach" or "post_publish_steps".');
    for (const req of gate.requires) {
      const match = String(req).match(/captured\.([a-zA-Z0-9_]+)/);
      if (match && !capturedIds.has(toCamel(match[1]))) warn('gates', `Gate "${gate.id}" references captured output "${match[1]}" but it is not declared.`, `Declare "${match[1]}" under captured outputs or runtime captured variables.`);
    }
  }
}

export function formatValidationIssues(issues) {
  if (!issues.length) return '';
  const lines = [];
  const errors = issues.filter(i => i.level === 'error');
  const warnings = issues.filter(i => i.level === 'warning');
  if (errors.length) {
    lines.push(`${errors.length} error(s) found:`);
    for (const issue of errors) { lines.push(`  ERROR [${issue.field}] ${issue.message}`); lines.push(`    Fix: ${issue.fix}`); }
  }
  if (warnings.length) {
    lines.push(`${warnings.length} warning(s):`);
    for (const issue of warnings) { lines.push(`  WARN  [${issue.field}] ${issue.message}`); lines.push(`    Fix: ${issue.fix}`); }
  }
  return lines.join('\n');
}
