#!/usr/bin/env node
/**
 * Acceptance test: distributor-album-submit (materialized scaffold)
 *
 * Proves that the one materialized Browsy workflow distributor-album-submit:
 *   - lives at workflows/distributor-album-submit/ with all expected files
 *   - has a field-map.local.json whose every selector is present in the
 *     verified fixture (no fabricated selectors)
 *   - dry-runs to status=dry_run_passed against the example package
 *   - live-runs to status=live_run_gated and emits human_approval_required
 *   - never clicks the final dangerous action (no browser launched in either
 *     mode for the example package, AND safety-policy blocks the fixture's
 *     final-action controls by selector + text)
 *   - returns missing_input when an asset entry has no path/url
 *   - returns selector_verification_required if field-map.local.json is missing
 *   - writes result.json that conforms to automation-result-v1
 *   - does not leak Pancake Robot / client-private names into src/, wizard/,
 *     adapters/, cli/, or core
 *
 * Usage:
 *   node scripts/acceptance-distributor-album-submit.mjs
 */

import fs   from 'fs';
import os   from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync }       from 'child_process';

import {
  validateResult,
  RETURN_CONTRACT_VERSION,
} from '../src/core/workflow-contract.mjs';
import { runWorkflowPackage } from '../src/core/workflow-run.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const REPO_ROOT  = path.resolve(__dirname, '..');
const WF_DIR     = path.join(REPO_ROOT, 'workflows', 'distributor-album-submit');
const PKG_PATH   = path.join(REPO_ROOT, 'examples', 'workflow-packages', 'distributor-album-submit.example.json');
const FIXTURE    = path.join(REPO_ROOT, 'fixtures', 'distrokid-wizard', 'index.html');

let passed = 0, failed = 0;
const failures = [];
function pass(label) { console.log('PASS  ' + label); passed++; }
function fail(label, detail = '') {
  console.error('FAIL  ' + label + (detail ? '\n      ' + detail : ''));
  failed++;
  failures.push(label);
}
function section(n, title) { console.log(`\n── Check ${n}: ${title} ──`); }

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'distributor-album-acceptance-'));

// ─────────────────────────────────────────────────────────────────────────────
section(1, 'workflows/distributor-album-submit/ exists with required files');
{
  for (const file of ['workflow.json', 'field-map.local.json', 'safety-policy.json', 'manifest.schema.json', 'README.md']) {
    fs.existsSync(path.join(WF_DIR, file))
      ? pass(`has ${file}`)
      : fail(`missing ${file}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
section(2, 'field-map.local.json — every selector is present in the fixture (no fabrication)');
{
  const fieldMap = JSON.parse(fs.readFileSync(path.join(WF_DIR, 'field-map.local.json'), 'utf8'));
  const fixtureHtml = fs.readFileSync(FIXTURE, 'utf8');

  const selectors = [];
  for (const [k, v] of Object.entries(fieldMap.fields || {})) selectors.push([k, v.selector]);
  for (const rg of fieldMap.repeatGroups || []) {
    if (rg.containerSelector) selectors.push([`repeatGroup.${rg.id}.container`, rg.containerSelector]);
    if (rg.itemSelector) selectors.push([`repeatGroup.${rg.id}.item`, rg.itemSelector]);
    if (rg.createAction?.selector) selectors.push([`repeatGroup.${rg.id}.createAction`, rg.createAction.selector]);
    for (const [k, v] of Object.entries(rg.itemFields || {})) selectors.push([`repeatGroup.${rg.id}.item.${k}`, v.selector]);
  }

  selectors.length > 0 ? pass(`found ${selectors.length} selectors to verify`) : fail('field-map has no selectors');

  for (const [label, sel] of selectors) {
    // Selectors here are attribute selectors:
    //   [attr='value']      → check attr="value" or attr='value' in the fixture
    //   [attr]              → check the bare attribute exists in the fixture
    const withValue = sel.match(/^\[([a-zA-Z0-9_-]+)=['"]([^'"]+)['"]\]$/);
    const bareAttr  = sel.match(/^\[([a-zA-Z0-9_-]+)\]$/);

    if (withValue) {
      const [, attr, value] = withValue;
      const variants = [`${attr}="${value}"`, `${attr}='${value}'`];
      variants.some(v => fixtureHtml.includes(v))
        ? pass(`fixture contains ${label} → ${sel}`)
        : fail(`fabricated selector — not found in fixture: ${label} → ${sel}`);
    } else if (bareAttr) {
      const [, attr] = bareAttr;
      // Attribute may appear as attr=, attr , or attr> (e.g., <div data-browsy-item-section>)
      const re = new RegExp(`\\b${attr}(=|\\s|>)`);
      re.test(fixtureHtml)
        ? pass(`fixture contains ${label} → ${sel}`)
        : fail(`fabricated selector — not found in fixture: ${label} → ${sel}`);
    } else {
      fail(`selector "${label}" has an unrecognized shape`, sel);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
section(3, 'dry_run on the example package → status=dry_run_passed');
let dryResult;
{
  const out = await runWorkflowPackage({ packagePath: PKG_PATH, modeOverride: 'dry_run', runRoot: TMP_ROOT });
  dryResult = out.result;
  out.status === 'dry_run_passed' ? pass(`status = "${out.status}"`) : fail('expected dry_run_passed', `got "${out.status}"`);
  out.result.return_contract_version === RETURN_CONTRACT_VERSION
    ? pass(`return_contract_version = "${RETURN_CONTRACT_VERSION}"`)
    : fail('wrong return_contract_version', out.result.return_contract_version);
  // No human_approval_required in dry_run
  const human = out.result.client_action_requests.find(r => r.type === 'human_approval_required');
  !human ? pass('no human_approval_required in dry_run') : fail('unexpected human_approval_required in dry_run');
}

// ─────────────────────────────────────────────────────────────────────────────
section(4, 'live mode on the example package → status=live_run_gated + human_approval_required');
{
  const out = await runWorkflowPackage({ packagePath: PKG_PATH, modeOverride: 'live', runRoot: TMP_ROOT });
  out.status === 'live_run_gated' ? pass(`status = "${out.status}"`) : fail('expected live_run_gated', `got "${out.status}"`);
  const human = out.result.client_action_requests.find(r => r.type === 'human_approval_required');
  human ? pass('human_approval_required emitted') : fail('no human_approval_required', JSON.stringify(out.result.client_action_requests));
  human?.severity === 'blocking' ? pass('approval severity is blocking') : fail('approval not blocking');
  out.result.manual_checkpoints.length > 0
    ? pass(`manual_checkpoints populated (${out.result.manual_checkpoints.length})`)
    : fail('manual_checkpoints empty');
  // Filled fields stays empty because Browsy never opens a browser in this path
  Array.isArray(out.result.filled_fields) && out.result.filled_fields.length === 0
    ? pass('no fields filled in live_run_gated path (final action not approached)')
    : fail('filled_fields unexpectedly populated', JSON.stringify(out.result.filled_fields));
}

// ─────────────────────────────────────────────────────────────────────────────
section(5, 'safety-policy.json blocks the final dangerous action by selector AND text');
{
  const policy = JSON.parse(fs.readFileSync(path.join(WF_DIR, 'safety-policy.json'), 'utf8'));
  const requiredText = ['Submit', 'Upload to stores'];
  for (const t of requiredText) {
    policy.never_click_text.includes(t)
      ? pass(`never_click_text contains "${t}"`)
      : fail(`never_click_text missing "${t}"`);
  }
  const requiredSelectors = ['#btn-submit', '#btn-release'];
  for (const s of requiredSelectors) {
    (policy.never_click_selectors || []).includes(s)
      ? pass(`never_click_selectors contains "${s}"`)
      : fail(`never_click_selectors missing "${s}"`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
section(6, 'missing assets → missing_input client_action_request');
{
  const tmpPkg = path.join(TMP_ROOT, 'pkg-missing-asset.json');
  fs.writeFileSync(tmpPkg, JSON.stringify({
    workflow_id: 'distributor-album-submit',
    source_system: 'external_client',
    entity_type: 'album',
    entity_id: 'ENT_MISSING',
    mode: 'dry_run',
    assets: [{ role: 'album_artwork' }],
  }, null, 2));
  const out = await runWorkflowPackage({ packagePath: tmpPkg, runRoot: TMP_ROOT });
  const missing = out.result.client_action_requests.find(r => r.type === 'missing_input');
  missing ? pass('missing_input emitted for asset with no path/url') : fail('no missing_input emitted', JSON.stringify(out.result.client_action_requests));
  out.status === 'blocked' ? pass('status=blocked when assets missing') : fail('expected blocked', `got "${out.status}"`);
}

// ─────────────────────────────────────────────────────────────────────────────
section(7, 'missing field-map.local.json → selector_verification_required');
{
  const renamed = path.join(WF_DIR, 'field-map.local.json');
  const backup  = path.join(WF_DIR, 'field-map.local.json.__test_backup');
  fs.renameSync(renamed, backup);
  try {
    const out = await runWorkflowPackage({ packagePath: PKG_PATH, modeOverride: 'dry_run', runRoot: TMP_ROOT });
    const sv = out.result.client_action_requests.find(r => r.type === 'selector_verification_required');
    sv ? pass('selector_verification_required emitted when field-map.local.json is absent') : fail('no selector_verification_required', JSON.stringify(out.result.client_action_requests));
    out.status === 'blocked' ? pass('status=blocked when field map missing') : fail('expected blocked', `got "${out.status}"`);
  } finally {
    fs.renameSync(backup, renamed);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
section(8, 'result.json conforms to automation-result-v1');
{
  const v = validateResult(dryResult);
  v.ok ? pass('dry_run result is contract-valid') : fail('contract violation', JSON.stringify(v.errors));
  // Required keys spot-check
  for (const k of ['workflow_id', 'run_id', 'source_system', 'entity_type', 'entity_id', 'status', 'captured_outputs', 'client_action_requests', 'return_contract_version']) {
    (k in dryResult) ? pass(`result has ${k}`) : fail(`result missing ${k}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
section(9, 'no Pancake Robot / client-private names in src/, wizard/, adapters/, cli/, or core');
{
  const banned = ['pancake', 'pancake robot', 'pancakerobot', 'release_cockpit', 'releasecockpit', 'needs_ken_tasks'];
  const targets = ['src/core', 'src/cli', 'src', 'wizard'];
  // adapters/ may not exist — only scan if present
  if (fs.existsSync(path.join(REPO_ROOT, 'adapters'))) targets.push('adapters');

  // Deduplicate (src/core and src/cli are inside src — that's fine, grep is cheap)
  const leaked = [];
  for (const t of new Set(targets)) {
    for (const b of banned) {
      try {
        const r = execSync(`grep -ril "${b}" ${path.join(REPO_ROOT, t)} || true`, { encoding: 'utf8' }).trim();
        if (r) leaked.push(`${b} in ${t}:\n        ${r.split('\n').join('\n        ')}`);
      } catch { /* grep returns nonzero with || true above */ }
    }
  }
  leaked.length === 0
    ? pass('src/, wizard/ (and adapters/ if present) are client-neutral')
    : fail('client-specific names leaked', leaked.join('\n      '));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('');
console.log(`Summary: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('Failures:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('All checks passed.');

try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch {}
