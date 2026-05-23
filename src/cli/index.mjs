#!/usr/bin/env node
import fs from 'fs';
import { join, resolve } from 'path';
import { parseArgs, requireArg, boolArg } from '../core/args.mjs';
import {
  REPO_ROOT, WORKFLOWS_DIR, OUTPUT_DIR,
  workflowDir, workflowAuthPath, workflowRunDir,
  ensureDir, exists, writeJson, writeText, readJson, safeId
} from '../core/paths.mjs';
import { defaultSafetyPolicy } from '../core/safety.mjs';
import { launchBrowser, writeDiscoveryArtifacts } from '../core/discovery.mjs';
import { parseRequest, loadAndParseRequest, formatValidationIssues } from '../core/request-parser.mjs';
import { generateCandidates, candidatesMarkdown } from '../core/field-map-candidates.mjs';

const argv = process.argv.slice(2);
const command = argv[0];
const subcommand = argv[1];
const args = parseArgs(argv.slice(command === 'auth' ? 2 : 1));

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printHelp() {
  console.log('Browsy v0.2 — automation harness factory');
  console.log('');
  console.log('Commands:');
  console.log('  browsy validate-request           Validate AUTOMATION_REQUEST.md');
  console.log('  browsy plan [--request FILE]       Generate build plan from request');
  console.log('  browsy init --id <id>              Create workflow scaffold');
  console.log('  browsy init --from-request         Create workflow from parsed request');
  console.log('  browsy auth save --workflow <id> --url <url>');
  console.log('  browsy auth check --workflow <id> --url <url>');
  console.log('  browsy discover --workflow <id> --url <url> [--candidates]');
  console.log('  browsy generate-prompt             Print coding agent prompt');
  console.log('  browsy run --workflow <id> --manifest <path> [--dry-run]');
}

// ---------------------------------------------------------------------------
// validate-request
// ---------------------------------------------------------------------------

function validateRequest() {
  const parsed = loadAndParseRequest();
  const errors = parsed.validationIssues.filter(i => i.level === 'error');
  const warnings = parsed.validationIssues.filter(i => i.level === 'warning');

  console.log(`Workflow:  ${parsed.workflowId}`);
  console.log(`Goal:      ${parsed.goal || '(empty)'}`);
  console.log(`URLs:      ${parsed.targetUrls.length} target(s)`);
  console.log(`Auth:      ${parsed.authMode}`);
  console.log(`Policy:    ${parsed.safetyPolicy ? 'valid JSON' : 'MISSING'}`);
  console.log(`Fields:    ${parsed.fieldsActions.length} row(s) in table`);
  console.log(`Manual:    ${parsed.manualOnlyActions.length} manual-only action(s)`);
  console.log(`Criteria:  ${parsed.acceptanceCriteria.length} acceptance criterion/a`);
  console.log('');

  if (errors.length || warnings.length) {
    console.log(formatValidationIssues(parsed.validationIssues));
    console.log('');
  }

  if (errors.length) {
    console.error(`FAIL: ${errors.length} error(s) must be fixed before proceeding.`);
    process.exit(1);
  }

  if (warnings.length) {
    console.log(`PASS (with ${warnings.length} warning(s)): AUTOMATION_REQUEST.md is valid.`);
  } else {
    console.log('PASS: AUTOMATION_REQUEST.md is valid.');
  }
}

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

function generatePlan() {
  const requestPath = args.request || join(REPO_ROOT, 'AUTOMATION_REQUEST.md');
  if (!exists(requestPath)) throw new Error('Request file not found: ' + requestPath);
  const text = fs.readFileSync(requestPath, 'utf8');
  const req = parseRequest(text);
  const errors = req.validationIssues.filter(i => i.level === 'error');

  if (errors.length) {
    console.error('Request has errors — fix before generating plan:');
    console.error(formatValidationIssues(req.validationIssues));
    process.exit(1);
  }

  const planDir = join(OUTPUT_DIR, 'plans', req.workflowId);
  ensureDir(planDir);

  const firstUrl = req.targetUrls.find(r => r.url?.startsWith('http'))?.url || '(none)';
  const requiresLogin = req.targetUrls.some(r => /yes|true/i.test(r.requires_login_));
  const hasFileUpload = req.fieldsActions.some(r => /upload|file/i.test(r['field_/_action'] || r.field || ''));
  const hasApiSystem = req.apis.some(r => r.type?.toLowerCase() !== 'files');
  const strategy = hasApiSystem ? 'API-first, Playwright for UI steps'
    : hasFileUpload ? 'Playwright (file upload + form fill)'
    : 'Playwright (form fill)';

  // Build plan JSON
  const plan = {
    generated_at: new Date().toISOString(),
    workflow_id: req.workflowId,
    goal: req.goal,
    execution_strategy: strategy,
    auth_mode: req.authMode,
    requires_login: requiresLogin,
    target_urls: req.targetUrls,
    discovery_urls: req.discoveryNeeds,
    field_action_map: req.fieldsActions,
    manual_only: req.manualOnlyActions,
    safety_constraints: req.safetyPolicy,
    runtime_variables: req.runtimeVariables,
    acceptance_criteria: req.acceptanceCriteria,
    required_workflow_files: [
      `workflows/${req.workflowId}/workflow.yaml`,
      `workflows/${req.workflowId}/workflow.json`,
      `workflows/${req.workflowId}/manifest.schema.json`,
      `workflows/${req.workflowId}/manifest.example.json`,
      `workflows/${req.workflowId}/safety-policy.json`,
      `workflows/${req.workflowId}/field-map.example.json`,
      `workflows/${req.workflowId}/field-map.local.json`,
      `workflows/${req.workflowId}/walkthrough.md`,
      `workflows/${req.workflowId}/run.mjs`,
      `workflows/${req.workflowId}/smoke-test.mjs`,
      `workflows/${req.workflowId}/README.md`
    ],
    tests_to_create: [
      'Discovery produces discovered-fields.json and discovered-fields.md',
      'Field-map candidates are generated',
      'Dry-run fills safe fields without error',
      'Dry-run skips legal/payment/final fields',
      'Submit/pay/final buttons are never clicked',
      'All run artifacts are written (run-log, filled, skipped, errors, screenshots)'
    ],
    unresolved_questions: buildUnresolvedQuestions(req)
  };

  // Build plan markdown
  const md = buildPlanMarkdown(req, plan);

  writeJson(join(planDir, 'build-plan.json'), plan);
  writeText(join(planDir, 'build-plan.md'), md);

  console.log(`Build plan written:`);
  console.log(`  ${join(planDir, 'build-plan.md')}`);
  console.log(`  ${join(planDir, 'build-plan.json')}`);
  console.log('');
  console.log('Next: run init:workflow --from-request to scaffold the workflow files.');
}

function buildUnresolvedQuestions(req) {
  const q = [];
  if (!req.safetyPolicy?.never_click_text?.length) q.push('Safety policy has no never_click_text entries — confirm defaults are sufficient.');
  if (req.discoveryNeeds.length === 0) q.push('No discovery URLs listed — run discovery after filling ## 11 in AUTOMATION_REQUEST.md.');
  if (req.fieldsActions.length === 0 || req.fieldsActions.every(r => Object.values(r).some(v => String(v).startsWith('(')))) {
    q.push('Fields table is empty — run discovery and identify selectors before proceeding to implementation.');
  }
  if (/manual.save.state/i.test(req.authMode)) {
    q.push('Auth mode is manual-save-state — user must run auth:save before the first run.');
  }
  if (req.walkthroughText.startsWith('(') || !req.walkthroughText) {
    q.push('No narrated walkthrough — record one with the wizard or write it manually in ## 16.');
  }
  return q;
}

function buildPlanMarkdown(req, plan) {
  const lines = [
    `# Build Plan: ${req.workflowId}`,
    '',
    `> Generated: ${plan.generated_at}`,
    '',
    '## Workflow',
    '',
    `- **ID:** \`${req.workflowId}\``,
    `- **Goal:** ${req.goal}`,
    '',
    '## Execution Strategy',
    '',
    `- **Strategy:** ${plan.execution_strategy}`,
    `- **Auth mode:** ${req.authMode}`,
    `- **Requires login:** ${plan.requires_login ? 'yes' : 'no'}`,
    '',
    '## Target URLs',
    '',
  ];

  if (req.targetUrls.length) {
    lines.push('| Purpose | URL | Login? | Notes |');
    lines.push('|---|---|---|---|');
    for (const r of req.targetUrls) {
      lines.push(`| ${r.purpose || ''} | ${r.url || ''} | ${r.requires_login_ || ''} | ${r.notes || ''} |`);
    }
  } else {
    lines.push('_No target URLs found._');
  }

  lines.push('', '## Discovery URLs', '');
  if (req.discoveryNeeds.length) {
    for (const u of req.discoveryNeeds) lines.push(`- ${u}`);
  } else {
    lines.push('_None listed. Add URLs to ## 11 in AUTOMATION_REQUEST.md._');
  }

  // Runtime variables section
  const rv = req.runtimeVariables;
  if (rv && (rv.input?.length || rv.captured?.length || rv.derived?.length)) {
    lines.push('', '## Runtime Variables', '');
    if (rv.input?.length) {
      lines.push('**Input (provided before run):**');
      for (const v of rv.input) lines.push(`- \`${v.name}\`${v.description ? ` — ${v.description}` : ''}${v.example ? ` (example: \`${v.example}\`)` : ''}`);
      lines.push('');
    }
    if (rv.captured?.length) {
      lines.push('**Captured (extracted during run):**');
      for (const v of rv.captured) {
        lines.push(`- \`${v.name}\` — source: \`${v.source}\`${v.regex ? `, regex: \`${v.regex}\`` : ''}${v.example ? `, example: \`${v.example}\`` : ''}${v.required === false ? ' _(optional)_' : ''}`);
      }
      lines.push('');
    }
    if (rv.derived?.length) {
      lines.push('**Derived (computed from other variables):**');
      for (const v of rv.derived) lines.push(`- \`${v.name}\` = \`${v.template}\``);
      lines.push('');
    }
  }

  lines.push('', '## Safety Constraints', '');
  const policy = req.safetyPolicy || defaultSafetyPolicy();
  lines.push('**Never click text:**');
  for (const t of (policy.never_click_text || [])) lines.push(`- \`${t}\``);
  lines.push('');
  lines.push('**Manual-only categories:**');
  for (const c of (policy.manual_only_categories || [])) lines.push(`- ${c}`);

  lines.push('', '## Required Workflow Files', '');
  for (const f of plan.required_workflow_files) lines.push(`- \`${f}\``);

  lines.push('', '## Tests to Create', '');
  for (const t of plan.tests_to_create) lines.push(`- [ ] ${t}`);

  lines.push('', '## Acceptance Criteria', '');
  for (const c of req.acceptanceCriteria) lines.push(`- [ ] ${c}`);

  if (plan.unresolved_questions.length) {
    lines.push('', '## Unresolved Questions / Assumptions', '');
    for (const q of plan.unresolved_questions) lines.push(`- ⚠ ${q}`);
  }

  lines.push('', '---', `_Generated by Browsy v0.2 plan command._`, '');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// init:workflow
// ---------------------------------------------------------------------------

function initWorkflow() {
  const fromRequest = boolArg(args['from-request'], false);

  if (fromRequest) {
    const req = loadAndParseRequest();
    const errors = req.validationIssues.filter(i => i.level === 'error');
    if (errors.length) {
      console.error('Request has errors — fix before initializing:');
      console.error(formatValidationIssues(req.validationIssues));
      process.exit(1);
    }
    initWorkflowFromRequest(req);
  } else {
    const id = safeId(requireArg(args, 'id', 'Example: npm run init:workflow -- --id my-workflow'));
    initWorkflowBasic(id);
  }
}

function initWorkflowBasic(id) {
  const dir = workflowDir(id);
  ensureDir(dir);
  const config = buildWorkflowConfig(id, { description: 'Generated Browsy workflow.', startUrl: '', authMode: 'manual-save-state' });
  writeWorkflowFiles(id, dir, config, {});
  console.log('Created workflow scaffold: ' + dir);
  console.log('Next steps:');
  console.log('  1. Fill in AUTOMATION_REQUEST.md');
  console.log('  2. npm run discover -- --workflow ' + id + ' --url https://...');
  console.log('  3. npm run run -- --workflow ' + id + ' --dry-run');
}

function initWorkflowFromRequest(req) {
  const id = req.workflowId;
  const dir = workflowDir(id);
  ensureDir(dir);

  const startUrlRow = req.targetUrls.find(r => r.url?.startsWith('http'));
  const startUrl = startUrlRow?.url || '';
  const startUrlExample = startUrlRow?.url_example || startUrlRow?.example_url || '';
  const config = buildWorkflowConfig(id, {
    description: req.goal,
    startUrl,
    startUrlExample: startUrlExample || undefined,
    authMode: req.authMode,
    targets: req.targetUrls,
    discoveryUrls: req.discoveryNeeds,
    variables: req.runtimeVariables,
  });

  writeWorkflowFiles(id, dir, config, req);
  console.log('Created workflow from request: ' + dir);
  console.log('');
  console.log('Next steps:');
  if (req.authMode !== 'none') {
    console.log('  1. npm run auth:save -- --workflow ' + id + ' --url ' + (startUrl || '<LOGIN_URL>'));
    console.log('  2. npm run discover -- --workflow ' + id + ' --url ' + (startUrl || '<START_URL>') + ' --candidates');
    console.log('  3. Review output/runs/' + id + '/.../field-map.candidates.md');
    console.log('  4. Create workflows/' + id + '/field-map.local.json from verified selectors');
    console.log('  5. npm run run -- --workflow ' + id + ' --manifest workflows/' + id + '/manifest.example.json --dry-run');
  } else {
    console.log('  1. npm run discover -- --workflow ' + id + ' --url ' + (startUrl || '<START_URL>') + ' --candidates');
    console.log('  2. npm run run -- --workflow ' + id + ' --dry-run');
  }
}

function buildWorkflowConfig(id, { description, startUrl, startUrlExample, authMode, targets = [], discoveryUrls = [], variables = null }) {
  const config = {
    id,
    description,
    auth: {
      mode: authMode || 'manual-save-state',
      storage_state: `.auth/${id}.json`
    },
    runtime: {
      dry_run_default: true,
      headed_default: true,
      pause_at_end_default: true
    },
    targets: {
      start_url: startUrl,
      urls: targets.map(r => {
        const entry = { purpose: r.purpose || '', url: r.url || '' };
        if (r.url_example || r.example_url) entry.url_example = r.url_example || r.example_url;
        return entry;
      })
    },
    discovery_urls: discoveryUrls,
    execution_strategy: 'playwright',
    artifacts: {
      screenshots: true,
      html_snapshot: true,
      page_text_snapshot: true,
      discovered_fields: true
    }
  };
  if (startUrlExample) config.targets.start_url_example = startUrlExample;
  if (variables && (variables.input?.length || variables.captured?.length || variables.derived?.length)) {
    config.variables = variables;
  }
  return config;
}

function writeWorkflowFiles(id, dir, config, req) {
  const safetyPolicy = (req.safetyPolicy && typeof req.safetyPolicy === 'object')
    ? req.safetyPolicy
    : defaultSafetyPolicy();

  // Input contract excludes captured variable names — they are runtime-only
  const capturedNames = new Set((req.runtimeVariables?.captured || []).map(v => v.name));
  const rawContract = req.inputDataContract || { id: 'ITEM_123' };
  const inputContract = Object.fromEntries(
    Object.entries(rawContract).filter(([k]) => !capturedNames.has(k))
  );

  const fieldMapExample = buildFieldMapExample(req.fieldsActions || []);

  const walkthrough = req.walkthroughText && !req.walkthroughText.startsWith('(')
    ? req.walkthroughText
    : '# Walkthrough\n\nRecord your walkthrough here. Describe each step you perform manually so the automation can replicate it.\n\nRun the wizard to record: `npm run wizard`\n';

  const files = {
    'workflow.yaml': buildWorkflowYaml(config),
    'workflow.json': JSON.stringify(config, null, 2) + '\n',
    'manifest.schema.json': buildManifestSchema(inputContract),
    'manifest.example.json': JSON.stringify(inputContract, null, 2) + '\n',
    'safety-policy.json': JSON.stringify(safetyPolicy, null, 2) + '\n',
    'field-map.example.json': JSON.stringify(fieldMapExample, null, 2) + '\n',
    'field-map.local.json.example': JSON.stringify({ _notes: 'Copy this file to field-map.local.json and replace selectors with verified values from discovery.', fields: {} }, null, 2) + '\n',
    'walkthrough.md': walkthrough,
    'README.md': buildWorkflowReadme(id, config, req),
    'run.mjs': buildRunScript(id, config),
    'smoke-test.mjs': buildSmokeTest(id)
  };

  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    if (!exists(path)) fs.writeFileSync(path, content);
  }
}

function buildWorkflowYaml(config) {
  const urls = config.targets.urls.map(u => {
    let s = `    - url: ${u.url}\n      purpose: ${u.purpose}`;
    if (u.url_example) s += `\n      url_example: ${u.url_example}`;
    return s;
  }).join('\n') || '    []';

  const rv = config.variables;
  let varsYaml = '';
  if (rv && (rv.input?.length || rv.captured?.length || rv.derived?.length)) {
    varsYaml = '\nvariables:';
    if (rv.input?.length) {
      varsYaml += '\n  input:';
      for (const v of rv.input) varsYaml += `\n    - name: ${v.name}${v.example ? `\n      example: ${v.example}` : ''}`;
    }
    if (rv.captured?.length) {
      varsYaml += '\n  captured:';
      for (const v of rv.captured) {
        varsYaml += `\n    - name: ${v.name}\n      source: ${v.source}`;
        if (v.regex) varsYaml += `\n      regex: "${v.regex}"`;
        if (v.selector) varsYaml += `\n      selector: "${v.selector}"`;
        if (v.example) varsYaml += `\n      example: ${v.example}`;
        if (v.required === false) varsYaml += `\n      required: false`;
      }
    }
    if (rv.derived?.length) {
      varsYaml += '\n  derived:';
      for (const v of rv.derived) varsYaml += `\n    - name: ${v.name}\n      template: "${v.template}"`;
    }
  }

  return `id: ${config.id}
description: ${config.description}
auth:
  mode: ${config.auth.mode}
  storage_state: ${config.auth.storage_state}
runtime:
  dry_run_default: ${config.runtime.dry_run_default}
  headed_default: ${config.runtime.headed_default}
  pause_at_end_default: ${config.runtime.pause_at_end_default}
targets:
  start_url: ${config.targets.start_url || ''}${config.targets.start_url_example ? '\n  start_url_example: ' + config.targets.start_url_example : ''}
  urls:
${urls}
execution_strategy: ${config.execution_strategy}
artifacts:
  screenshots: ${config.artifacts.screenshots}
  html_snapshot: ${config.artifacts.html_snapshot}
  page_text_snapshot: ${config.artifacts.page_text_snapshot}
  discovered_fields: ${config.artifacts.discovered_fields}${varsYaml}
`;
}

function buildManifestSchema(example) {
  const props = {};
  for (const [k, v] of Object.entries(example)) {
    if (k.startsWith('_')) continue;
    props[k] = { type: typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'string' };
  }
  return JSON.stringify({ type: 'object', required: Object.keys(props).filter(k => !k.startsWith('_')), properties: props }, null, 2) + '\n';
}

function buildFieldMapExample(fieldsActions) {
  const fields = {};
  for (const row of fieldsActions) {
    const name = (row['field_/_action'] || row.field || '').trim();
    if (!name || name.startsWith('(')) continue;
    const source = (row['source_in_input'] || row.source || '').trim();
    fields[safeId(name)] = {
      selector: '(run discovery to find selector)',
      type: 'text',
      source: source || safeId(name),
      required: false,
      safety_category: null
    };
  }
  return {
    _notes: 'Populate selectors from discovery candidates. Create field-map.local.json with verified values.',
    fields
  };
}

function buildWorkflowReadme(id, config, req) {
  const startUrl = config.targets.start_url || '<START_URL>';
  const authMode = config.auth.mode;
  const discovery = config.discovery_urls?.length ? config.discovery_urls[0] : startUrl;

  return `# ${id}

${req.goal || 'Browsy automation workflow.'}

## Purpose

${req.goal || '(No goal specified — fill in AUTOMATION_REQUEST.md ## 2)'}

## Auth setup

Auth mode: \`${authMode}\`

${authMode === 'manual-save-state' ? `1. Log in manually once:
   \`\`\`bash
   npm run auth:save -- --workflow ${id} --url ${startUrl}
   \`\`\`
2. Verify the session was saved:
   \`\`\`bash
   npm run auth:check -- --workflow ${id} --url ${startUrl}
   \`\`\`` : 'No browser auth required.'}

## Discovery

Run discovery to map the live page DOM:

\`\`\`bash
npm run discover -- --workflow ${id} --url ${discovery} --candidates
\`\`\`

Artifacts written to: \`output/runs/${id}/<timestamp>/\`

Review \`field-map.candidates.md\`, then create \`workflows/${id}/field-map.local.json\` with verified selectors.

## Dry-run

\`\`\`bash
npm run run -- --workflow ${id} --manifest workflows/${id}/manifest.example.json --dry-run
\`\`\`

## Expected artifacts

Every run writes to \`output/runs/${id}/<timestamp>/\`:

- \`run-log.json\` — timestamped action log
- \`filled-fields.json\` — fields that were filled
- \`skipped-fields.json\` — fields that were skipped and why
- \`errors.json\` — any errors encountered
- \`screenshot-start.png\`
- \`screenshot-after-fill.png\`
- \`page-text-snapshot.txt\`
- \`html-snapshot.html\`

## Manual checkpoints ⚠

The following actions **must stay manual** and will never be executed automatically:

${(req.manualOnlyActions || []).map(a => `- ${a}`).join('\n') || '- (see safety-policy.json)'}

The browser pauses before any final action. Review the form, then complete manually.

## Known limitations

- Field selectors in \`field-map.example.json\` are placeholders. Run discovery and verify.
- Auth state must be saved before the first run on authenticated pages.
- This automation does not handle CAPTCHAs or dynamic login flows.

## Running smoke tests

\`\`\`bash
npm run smoke
\`\`\`
${buildRuntimeVarsReadmeSection(config)}`;
}

function buildRuntimeVarsReadmeSection(config) {
  const rv = config.variables;
  if (!rv || !(rv.input?.length || rv.captured?.length || rv.derived?.length)) return '';
  const lines = ['\n## Runtime variables\n'];
  if (rv.input?.length) {
    lines.push('**Input variables** (provide in the manifest):\n');
    for (const v of rv.input) lines.push(`- \`${v.name}\`${v.example ? ` — e.g. \`${v.example}\`` : ''}`);
    lines.push('');
  }
  if (rv.captured?.length) {
    lines.push('**Captured variables** (extracted automatically during the run — not required in the manifest):\n');
    for (const v of rv.captured) {
      lines.push(`- \`${v.name}\` — source: \`${v.source}\`${v.regex ? `, regex: \`${v.regex}\`` : ''}${v.example ? ` (example: \`${v.example}\`)` : ''}`);
    }
    lines.push('');
  }
  if (rv.derived?.length) {
    lines.push('**Derived variables** (computed from input + captured):\n');
    for (const v of rv.derived) lines.push(`- \`${v.name}\` = \`${v.template}\``);
    lines.push('');
  }
  lines.push('All captured and derived values are saved to `runtime-vars.json` in the run directory.\n');
  return lines.join('\n');
}

function buildRunScript(id, config) {
  const startUrl = config.targets.start_url || '';
  return `#!/usr/bin/env node
/**
 * Workflow runner: ${id}
 * Goal: ${config.description}
 *
 * Generated by Browsy v0.3 — review before first use.
 * Replace placeholder selectors in field-map.local.json before running against a real site.
 *
 * Usage:
 *   node workflows/${id}/run.mjs [--manifest path] [--dry-run] [--headed] [--no-pause] [--allow-final-action]
 */
import { parseArgs, boolArg } from '../../src/core/args.mjs';
import {
  loadWorkflowConfig, loadManifest, loadSafetyPolicy, loadFieldMap,
  createRunDir, createRunLogger, writeRunArtifact, saveScreenshot,
  recordFilledField, recordSkippedField, recordError, finalizeRun,
  getManifestValue,
  resolveTemplate, hasTemplateVars, captureVariables, computeDerived, saveRuntimeVars
} from '../../src/core/workflow-runtime.mjs';
import { isDangerousText, isManualOnly } from '../../src/core/safety.mjs';
import { PlaywrightAdapter } from '../../src/adapters/playwright-adapter.mjs';

const WORKFLOW_ID = '${id}';

const rawArgs = process.argv.slice(2);
const args = parseArgs(rawArgs);
const manifestPath = args.manifest || \`workflows/\${WORKFLOW_ID}/manifest.example.json\`;
const dryRun = boolArg(args['dry-run'], true);
const headed = boolArg(args.headed, true);
const noPause = boolArg(args['no-pause'], false);
const allowFinalAction = boolArg(args['allow-final-action'], false);

if (!dryRun && !allowFinalAction) {
  console.log('[INFO] Running in live mode with dry-run=false.');
  console.log('[INFO] Final actions still require --allow-final-action AND explicit safety policy approval.');
}

const config = loadWorkflowConfig(WORKFLOW_ID);
const manifest = loadManifest(manifestPath);
const policy = loadSafetyPolicy(WORKFLOW_ID);
const fieldMap = loadFieldMap(WORKFLOW_ID);

const runDir = createRunDir(WORKFLOW_ID);
const logger = createRunLogger(runDir);

logger.log('info', \`Workflow: \${WORKFLOW_ID}\`, { dryRun, headed, manifestPath, runDir });

const filled = [];
const skipped = [];
const errors = [];
const adapter = new PlaywrightAdapter();

// Runtime variable context — seeded from input variables declared in workflow.json.
// Input variables are resolved from the manifest; captured/derived are added during the run.
const varDefs = config.variables || { input: [], captured: [], derived: [] };
let runtimeVars = {};
for (const def of (varDefs.input || [])) {
  const val = manifest[def.name];
  if (val !== undefined && val !== null) runtimeVars[def.name] = String(val);
}

// Helper: resolve a URL template if it contains {{...}} tokens, or return it as-is.
function resolveUrl(urlTemplate) {
  if (!hasTemplateVars(urlTemplate)) return urlTemplate;
  try {
    return resolveTemplate(urlTemplate, runtimeVars);
  } catch (e) {
    throw new Error(\`Cannot navigate — \${e.message}. Check that all capture steps ran before this navigation.\`);
  }
}

// Helper: run variable capture + derive after a navigation step.
async function captureAndDerive(label) {
  if (!(varDefs.captured || []).length) return;
  const { vars: updated, missing } = await captureVariables(adapter.page, varDefs.captured, runtimeVars);
  runtimeVars = computeDerived(varDefs.derived || [], updated);
  saveRuntimeVars(runDir, runtimeVars);
  if (missing.length) {
    logger.log('warn', \`[CAPTURE] Missing required variable(s) after \${label}: \${missing.join(', ')}\`);
    for (const name of missing) {
      recordSkippedField(skipped, name, \`missing runtime variable: \${name}\`);
    }
    return missing;
  }
  logger.log('info', \`[CAPTURE] Variables captured after \${label}: \${Object.keys(runtimeVars).join(', ')}\`);
  return [];
}

try {
  await adapter.open({ headed, storageState: \`.auth/\${WORKFLOW_ID}.json\`, dryRun });

  const startUrlTemplate = config.targets?.start_url || '${startUrl}';
  if (!startUrlTemplate) throw new Error('No start_url in workflow.json. Set targets.start_url.');

  const startUrl = resolveUrl(startUrlTemplate);
  logger.log('info', 'Navigating to: ' + startUrl);
  await adapter.page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await adapter.snapshot(runDir, 'screenshot-start.png');

  // Capture runtime variables from the start page if any capture specs are declared.
  const missingAfterStart = await captureAndDerive('start page');
  if (missingAfterStart?.length) {
    logger.log('error', 'Stopping: required runtime variable(s) could not be captured from start page.');
    finalizeRun(runDir, { logger, filled, skipped, errors, workflowId: WORKFLOW_ID, startUrl, dryRun, runtimeVars });
    await adapter.close().catch(() => {});
    process.exit(1);
  }

  writeRunArtifact(runDir, 'page-text-snapshot.txt', await adapter.text());
  writeRunArtifact(runDir, 'html-snapshot.html', await adapter.html());

  const fields = Object.entries(fieldMap.fields || {});
  if (!fields.length) {
    logger.log('warn', 'Field map is empty. Run discovery and create field-map.local.json.');
  }

  for (const [fieldName, fieldConfig] of fields) {
    const { selector, type, source, safety_category, redact } = fieldConfig;

    // Safety: skip manual-only fields
    if (safety_category && isManualOnly(safety_category, policy)) {
      logger.log('info', \`Skipped (manual-only: \${safety_category}): \${fieldName}\`);
      recordSkippedField(skipped, fieldName, \`manual-only: \${safety_category}\`, selector);
      continue;
    }

    // Safety: skip buttons with dangerous text
    if ((type === 'button' || type === 'submit') && isDangerousText(fieldName, policy)) {
      logger.log('info', \`Skipped (dangerous text): \${fieldName}\`);
      recordSkippedField(skipped, fieldName, 'dangerous text', selector);
      continue;
    }

    const value = getManifestValue(manifest, source);
    if (value === undefined || value === null) {
      if (source) {
        logger.log('warn', \`No value in manifest for: \${fieldName} (source: \${source})\`);
      }
      recordSkippedField(skipped, fieldName, \`no manifest value (source: \${source || 'none'})\`, selector);
      continue;
    }

    if (dryRun) {
      logger.log('info', \`[DRY-RUN] Would \${type} "\${fieldName}" = \${redact ? '[REDACTED]' : JSON.stringify(value)}\`, { selector });
      recordFilledField(filled, fieldName, selector, value, !!redact);
      continue;
    }

    try {
      if (type === 'text' || type === 'email' || type === 'url') {
        await adapter.fill(selector, value);
      } else if (type === 'textarea') {
        await adapter.fill(selector, value);
      } else if (type === 'select') {
        await adapter.selectOption(selector, value);
      } else if (type === 'file') {
        await adapter.upload(selector, value);
      } else if (type === 'checkbox') {
        await adapter.setChecked(selector, Boolean(value));
      } else {
        logger.log('warn', \`Unsupported field type "\${type}" for \${fieldName}\`);
        recordSkippedField(skipped, fieldName, \`unsupported type: \${type}\`, selector);
        continue;
      }
      logger.log('info', \`Filled: \${fieldName}\`, { selector, type });
      recordFilledField(filled, fieldName, selector, value, !!redact);
    } catch (err) {
      logger.log('error', \`Failed to fill \${fieldName}: \${err.message}\`, { selector });
      recordError(errors, fieldName, err, selector);
    }
  }

  await adapter.snapshot(runDir, 'screenshot-after-fill.png');
  logger.log('info', 'Fill phase complete. Browser paused for manual review.');

  if (!noPause && (dryRun || policy.pause_at_end_default)) {
    console.log('');
    console.log('--- MANUAL CHECKPOINT ---');
    console.log('Review the browser. Complete any manual-only actions.');
    console.log('Close the browser window to end the run.');
    await adapter.waitForClose();
  } else {
    await adapter.close();
  }

} catch (err) {
  logger.log('error', 'Workflow error: ' + err.message);
  recordError(errors, 'workflow', err);
  await adapter.close().catch(() => {});
} finally {
  finalizeRun(runDir, { logger, filled, skipped, errors, workflowId: WORKFLOW_ID, startUrl: config.targets?.start_url || '', dryRun, runtimeVars: Object.keys(runtimeVars).length ? runtimeVars : null });
}
`;
}

function buildSmokeTest(id) {
  return `#!/usr/bin/env node
import fs from 'fs';
import { join } from 'path';
import { REPO_ROOT } from '../../src/core/paths.mjs';

const workflowDir = join(REPO_ROOT, 'workflows', '${id}');
const required = [
  'workflow.yaml', 'workflow.json', 'manifest.schema.json', 'manifest.example.json',
  'safety-policy.json', 'field-map.example.json', 'run.mjs', 'README.md'
];
let failed = 0;
for (const f of required) {
  const path = join(workflowDir, f);
  if (!fs.existsSync(path)) { console.error('FAIL missing: ' + f); failed++; }
  else console.log('PASS exists: ' + f);
}
if (failed) { console.error(failed + ' checks failed.'); process.exit(1); }
console.log('PASS: ${id} smoke checks passed.');
`;
}

// ---------------------------------------------------------------------------
// auth save / check
// ---------------------------------------------------------------------------

async function authSave() {
  const workflow = safeId(requireArg(args, 'workflow'));
  const url = requireArg(args, 'url');
  ensureDir(join(REPO_ROOT, '.auth'));
  const authPath = workflowAuthPath(workflow);
  console.log('Launching browser for manual auth. Log in, then close the browser after auth saves.');
  const { browser, context, page } = await launchBrowser({ headed: true });
  async function save(trigger) {
    try {
      await context.storageState({ path: authPath });
      console.log('[auth] saved ' + workflow + ' (' + trigger + ') at ' + new Date().toISOString());
    } catch {}
  }
  page.on('load', () => save('load'));
  page.on('domcontentloaded', () => save('domcontentloaded'));
  page.on('framenavigated', () => save('framenavigated'));
  const interval = setInterval(() => save('interval'), 5000);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await new Promise(resolve => browser.on('disconnected', resolve));
  clearInterval(interval);
  if (!exists(authPath)) throw new Error('Auth file was not saved: ' + authPath);
  console.log('Auth saved: ' + authPath);
}

async function authCheck() {
  const workflow = safeId(requireArg(args, 'workflow'));
  const url = requireArg(args, 'url');
  const authPath = workflowAuthPath(workflow);
  if (!exists(authPath)) throw new Error('Missing auth file. Run auth save first: ' + authPath);
  const runDir = workflowRunDir(workflow, 'auth-check');
  const { browser, page } = await launchBrowser({ headed: boolArg(args.headed, true), storageState: authPath });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  ensureDir(runDir);
  await page.screenshot({ path: join(runDir, 'auth-check.png'), fullPage: true }).catch(() => {});
  writeText(join(runDir, 'auth-check-url.txt'), page.url() + '\n');
  console.log('Reached: ' + page.url());
  console.log('Artifacts: ' + runDir);
  await browser.close();
}

// ---------------------------------------------------------------------------
// discover (with optional --candidates flag)
// ---------------------------------------------------------------------------

async function discover() {
  const workflow = safeId(requireArg(args, 'workflow'));
  const url = requireArg(args, 'url');
  const withCandidates = boolArg(args.candidates, false);
  const authPath = workflowAuthPath(workflow);
  const storageState = exists(authPath) ? authPath : undefined;
  const runDir = workflowRunDir(workflow);
  const { browser, page } = await launchBrowser({ headed: boolArg(args.headed, true), storageState });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const discovery = await writeDiscoveryArtifacts(page, runDir);

  if (withCandidates) {
    // Load request fields for matching
    let requestFields = [];
    try {
      const req = loadAndParseRequest();
      requestFields = req.fieldsActions;
    } catch {}

    const data = generateCandidates(discovery, requestFields);
    const { writeJson, writeText } = await import('../core/paths.mjs');
    writeJson(join(runDir, 'field-map.candidates.json'), data);
    writeText(join(runDir, 'field-map.candidates.md'), candidatesMarkdown(data));
    console.log('Field-map candidates written.');
  }

  console.log('Discovery written: ' + runDir);

  if (boolArg(args.pause, false)) {
    console.log('Browser left open. Close it when done.');
    await new Promise(resolve => browser.on('disconnected', resolve));
  } else {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// generate-prompt (kept for backwards compatibility)
// ---------------------------------------------------------------------------

function generatePrompt() {
  const text = fs.readFileSync(join(REPO_ROOT, 'AUTOMATION_REQUEST.md'), 'utf8');
  console.log('# Coding Agent Prompt\n');
  console.log('Read AGENTS.md and build the completed automation harness described in AUTOMATION_REQUEST.md.\n');
  console.log(text);
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

async function runWorkflow() {
  const workflow = safeId(requireArg(args, 'workflow'));
  const runner = join(workflowDir(workflow), 'run.mjs');
  if (!exists(runner)) throw new Error('Missing workflow runner: ' + runner);
  const { spawnSync } = await import('child_process');
  const result = spawnSync(process.execPath, [runner, ...process.argv.slice(3)], { stdio: 'inherit', cwd: REPO_ROOT });
  process.exit(result.status ?? 1);
}

// ---------------------------------------------------------------------------
// discover:all — discover all URLs listed in workflow.json discovery_urls
// ---------------------------------------------------------------------------

async function discoverAll() {
  const workflow = safeId(requireArg(args, 'workflow'));
  const configPath = join(workflowDir(workflow), 'workflow.json');
  if (!exists(configPath)) throw new Error('No workflow.json found. Run: npm run init:workflow -- --id ' + workflow);
  const config = readJson(configPath);
  const urls = config.discovery_urls || [];
  if (!urls.length) {
    const startUrl = config.targets?.start_url;
    if (startUrl) urls.push(startUrl);
  }
  if (!urls.length) throw new Error('No discovery_urls in workflow.json. Add URLs to ## 11 in AUTOMATION_REQUEST.md and re-run init.');
  console.log(`Discovering ${urls.length} URL(s) for workflow: ${workflow}`);
  for (const url of urls) {
    console.log('\n─── ' + url + ' ───');
    const authPath = workflowAuthPath(workflow);
    const storageState = exists(authPath) ? authPath : undefined;
    const runDir = workflowRunDir(workflow);
    const { browser, page } = await launchBrowser({ headed: boolArg(args.headed, true), storageState });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const discovery = await writeDiscoveryArtifacts(page, runDir);
    const { generateCandidates: gc, candidatesMarkdown: cm } = await import('../core/field-map-candidates.mjs');
    let requestFields = [];
    try { const req = loadAndParseRequest(); requestFields = req.fieldsActions; } catch {}
    const data = gc(discovery, requestFields);
    writeJson(join(runDir, 'field-map.candidates.json'), data);
    writeText(join(runDir, 'field-map.candidates.md'), cm(data));
    console.log('  Discovery + candidates: ' + runDir);
    await browser.close();
  }
  console.log('\nDiscover:all complete.');
}

// ---------------------------------------------------------------------------
// review — display or generate run-review.md for a specific run
// ---------------------------------------------------------------------------

async function reviewRun() {
  const workflow = safeId(requireArg(args, 'workflow'));
  const runId = args.run;
  const { generateRunReview } = await import('../core/run-review.mjs');

  const outputBase = join(REPO_ROOT, 'output', 'runs', workflow);
  if (!exists(outputBase)) throw new Error('No runs found for workflow: ' + workflow);

  let runDir;
  if (runId) {
    runDir = join(outputBase, runId);
  } else {
    // Use latest run
    const runs = fs.readdirSync(outputBase).sort().reverse();
    if (!runs.length) throw new Error('No run directories found in: ' + outputBase);
    runDir = join(outputBase, runs[0]);
    console.log('Using latest run: ' + runs[0]);
  }
  if (!exists(runDir)) throw new Error('Run directory not found: ' + runDir);

  const reviewPath = join(runDir, 'run-review.md');
  if (exists(reviewPath)) {
    console.log('run-review.md:');
    console.log(fs.readFileSync(reviewPath, 'utf8'));
    return;
  }

  // Generate from existing artifacts
  const filled = exists(join(runDir, 'filled-fields.json')) ? readJson(join(runDir, 'filled-fields.json')) : [];
  const skipped = exists(join(runDir, 'skipped-fields.json')) ? readJson(join(runDir, 'skipped-fields.json')) : [];
  const errors = exists(join(runDir, 'errors.json')) ? readJson(join(runDir, 'errors.json')) : [];
  const review = generateRunReview({ workflowId: workflow, runDir, filled, skipped, errors });
  writeText(reviewPath, review);
  console.log('run-review.md generated: ' + reviewPath);
  console.log('\n' + review);
}

// ---------------------------------------------------------------------------
// feedback — save user feedback and record patch summary
// ---------------------------------------------------------------------------

function saveFeedback() {
  const workflow = safeId(requireArg(args, 'workflow'));
  const notesPath = args.notes;
  const runId = args.run || 'manual';

  const feedbackDir = join(workflowDir(workflow), 'feedback');
  ensureDir(feedbackDir);

  let notes = '';
  if (notesPath && exists(notesPath)) {
    notes = fs.readFileSync(notesPath, 'utf8');
  } else if (args.message) {
    notes = args.message;
  } else {
    throw new Error('Provide feedback via --notes feedback.md or --message "your feedback here"');
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const feedbackFile = join(feedbackDir, `${ts}-user-feedback.md`);
  const patchFile = join(feedbackDir, `${ts}-patch-summary.md`);

  writeText(feedbackFile, `# User Feedback\n\nRun: ${runId}\nTime: ${ts}\n\n${notes}\n`);

  const patch = [
    `# Patch Summary`,
    '',
    `**Triggered by run:** ${runId}`,
    `**Feedback recorded:** ${feedbackFile}`,
    `**Time:** ${new Date().toISOString()}`,
    '',
    '## Feedback',
    '',
    notes,
    '',
    '## Changes Made',
    '',
    '_Review feedback above and update field-map.local.json, safety-policy.json, or workflow.json as needed._',
    '',
    '## Safety Policy Changed?',
    '',
    'No — review manually.',
    '',
    '## Before / After',
    '',
    '_Document selector or config changes here after applying._',
    ''
  ].join('\n');

  writeText(patchFile, patch);
  console.log('Feedback saved:');
  console.log('  ' + feedbackFile);
  console.log('  ' + patchFile);
  console.log('\nNext: update workflow files based on feedback, then re-run dry-run.');
}

// ---------------------------------------------------------------------------
// promote — mark workflow as stable/reusable
// ---------------------------------------------------------------------------

function promoteWorkflow() {
  const workflow = safeId(requireArg(args, 'workflow'));
  const dir = workflowDir(workflow);
  if (!exists(dir)) throw new Error('Workflow not found: ' + dir);

  const configPath = join(dir, 'workflow.json');
  const config = exists(configPath) ? readJson(configPath) : {};

  // Find latest run
  const outputBase = join(REPO_ROOT, 'output', 'runs', workflow);
  const runs = exists(outputBase) ? fs.readdirSync(outputBase).sort().reverse() : [];
  const latestRun = runs[0] || 'unknown';

  const promotedContent = [
    `# ${workflow} — PROMOTED`,
    '',
    `Promoted: ${new Date().toISOString()}`,
    `Last successful dry-run: ${latestRun}`,
    '',
    '## Auth mode',
    '',
    config.auth?.mode || 'unknown',
    '',
    '## Manual checkpoints',
    '',
    ...(config.safety?.manual_only_categories || ['(see safety-policy.json)']).map(c => `- ${c}`),
    '',
    '## Expected inputs',
    '',
    `See: workflows/${workflow}/manifest.schema.json`,
    '',
    '## Output artifacts',
    '',
    `See: output/runs/${workflow}/<timestamp>/`,
    '',
    '## Safety policy',
    '',
    `See: workflows/${workflow}/safety-policy.json`,
    ''
  ].join('\n');

  writeText(join(dir, 'PROMOTED'), promotedContent);

  // Update workflow.json with promoted flag
  config.promoted = true;
  config.promoted_at = new Date().toISOString();
  config.last_good_run = latestRun;
  writeJson(configPath, config);

  console.log(`Workflow promoted: ${workflow}`);
  console.log(`  Status file: workflows/${workflow}/PROMOTED`);
  console.log(`  Last run: ${latestRun}`);
  console.log('\nThis workflow is marked as stable and reusable.');
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

try {
  if (!command || command === 'help' || command === '--help') printHelp();
  else if (command === 'validate-request') validateRequest();
  else if (command === 'plan') generatePlan();
  else if (command === 'init') initWorkflow();
  else if (command === 'auth' && subcommand === 'save') await authSave();
  else if (command === 'auth' && subcommand === 'check') await authCheck();
  else if (command === 'discover') await discover();
  else if (command === 'discover:all') await discoverAll();
  else if (command === 'generate-prompt') generatePrompt();
  else if (command === 'run') await runWorkflow();
  else if (command === 'review') await reviewRun();
  else if (command === 'feedback') saveFeedback();
  else if (command === 'promote') promoteWorkflow();
  else { printHelp(); process.exit(1); }
} catch (error) {
  console.error('FAIL: ' + error.message);
  if (process.env.BROWSY_DEBUG) console.error(error.stack);
  process.exit(1);
}
