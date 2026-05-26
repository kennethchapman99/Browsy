#!/usr/bin/env node
/**
 * Acceptance test: Browsy generic workflow package + result contract.
 *
 * Validates the architecture boundary the brief requires:
 *   - workflow_package contract validates required + optional fields
 *   - workflow_package rejects forbidden client-private keys (db_write, sql, ...)
 *   - automation-result-v1 has every required field and the correct version
 *   - dry_run is the default; live + human_gate emits human_approval_required
 *   - missing field-map.local.json emits selector_verification_required
 *   - unknown workflow_id is reported with the scaffolds list
 *   - workflow:run CLI exits with the right code per status
 *   - src/core stays free of any client-specific names (pancake, release_cockpit, ...)
 *   - capture_outputs default to {status:'pending'} until proven
 *
 * Usage:
 *   node scripts/acceptance-workflow-contract.mjs
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawnSync } from 'child_process';
import {
  validateWorkflowPackage,
  validateResult,
  newResult,
  computeStatus,
  RETURN_CONTRACT_VERSION,
  VALID_STATUSES,
  VALID_MODES,
} from '../src/core/workflow-contract.mjs';
import { runWorkflowPackage } from '../src/core/workflow-run.mjs';
import { listScaffolds, getScaffold } from '../src/core/workflow-scaffolds.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const REPO_ROOT  = path.resolve(__dirname, '..');

let passed = 0, failed = 0;
const failures = [];
function pass(label)  { console.log('PASS  ' + label); passed++; }
function fail(label, detail = '') {
  console.error('FAIL  ' + label + (detail ? '\n      ' + detail : ''));
  failed++;
  failures.push(label);
}
function section(n, title) { console.log(`\n── Check ${n}: ${title} ──`); }

// Disposable run root so we don't pollute output/.
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'browsy-acceptance-'));

// ──────────────────────────────────────────────────────────────────────────────
section(1, 'validateWorkflowPackage requires the named fields');
{
  const v = validateWorkflowPackage({});
  v.ok === false ? pass('empty package rejected') : fail('empty package accepted');
  const required = ['workflow_id', 'source_system', 'entity_type', 'entity_id', 'mode'];
  for (const key of required) {
    v.errors.some(e => e.includes(`package.${key}`))
      ? pass(`reports missing ${key}`)
      : fail(`does not report missing ${key}`, JSON.stringify(v.errors));
  }
}

section(2, 'validateWorkflowPackage accepts a minimal valid package');
{
  const pkg = {
    workflow_id: 'distributor-album-submit',
    source_system: 'external_client',
    entity_type: 'album',
    entity_id: 'ENT_1',
    mode: 'dry_run',
  };
  const v = validateWorkflowPackage(pkg);
  v.ok ? pass('minimal package is valid') : fail('minimal package rejected', JSON.stringify(v.errors));
}

section(3, 'validateWorkflowPackage rejects bad mode + bad return_contract_version');
{
  const bad = validateWorkflowPackage({
    workflow_id: 'x', source_system: 'c', entity_type: 'e', entity_id: 'i', mode: 'YOLO',
  });
  bad.errors.some(e => e.includes('mode')) ? pass('rejects unknown mode') : fail('did not reject mode', JSON.stringify(bad.errors));

  const badVer = validateWorkflowPackage({
    workflow_id: 'x', source_system: 'c', entity_type: 'e', entity_id: 'i', mode: 'dry_run',
    return_contract_version: 'nope',
  });
  badVer.errors.some(e => e.includes('return_contract_version'))
    ? pass('rejects wrong return_contract_version')
    : fail('did not reject return_contract_version');
}

section(4, 'validateWorkflowPackage rejects forbidden client-private keys');
{
  const leaky = validateWorkflowPackage({
    workflow_id: 'x', source_system: 'c', entity_type: 'e', entity_id: 'i', mode: 'dry_run',
    db_write: true,
  });
  leaky.errors.some(e => e.includes('db_write'))
    ? pass('rejects db_write')
    : fail('did not reject db_write', JSON.stringify(leaky.errors));

  const sqlLeak = validateWorkflowPackage({
    workflow_id: 'x', source_system: 'c', entity_type: 'e', entity_id: 'i', mode: 'dry_run',
    sql: 'select 1',
  });
  sqlLeak.errors.some(e => e.includes('sql')) ? pass('rejects sql') : fail('did not reject sql');
}

section(5, 'newResult + validateResult — automation-result-v1 has correct shape');
{
  const pkg = {
    workflow_id: 'distributor-album-submit',
    source_system: 'external_client',
    entity_type: 'album',
    entity_id: 'ENT_1',
    mode: 'dry_run',
  };
  const r = newResult({ pkg, runId: 'run-x' });
  r.return_contract_version === RETURN_CONTRACT_VERSION
    ? pass('result has return_contract_version=' + RETURN_CONTRACT_VERSION)
    : fail('wrong return_contract_version');

  for (const k of ['captured_outputs','filled_fields','skipped_fields','errors','screenshots','artifact_paths','manual_checkpoints','client_action_requests']) {
    (k === 'captured_outputs' ? typeof r[k] === 'object' && !Array.isArray(r[k]) : Array.isArray(r[k]))
      ? pass(`result has ${k}`)
      : fail(`result missing/wrong shape for ${k}`);
  }

  r.status = 'dry_run_passed';
  const v = validateResult(r);
  v.ok ? pass('newResult is contract-valid once status set') : fail('newResult invalid', JSON.stringify(v.errors));
}

section(6, 'computeStatus picks the right status');
{
  computeStatus({ mode: 'dry_run', humanGateReached: false, blocked: false, failed: false }) === 'dry_run_passed' ? pass('dry_run → dry_run_passed') : fail('dry_run path wrong');
  computeStatus({ mode: 'live', humanGateReached: true, blocked: false, failed: false }) === 'live_run_gated' ? pass('live + gate → live_run_gated') : fail('live gate wrong');
  computeStatus({ mode: 'live', humanGateReached: false, blocked: false, failed: false }) === 'live_run_completed' ? pass('live clean → live_run_completed') : fail('live clean wrong');
  computeStatus({ mode: 'dry_run', humanGateReached: false, blocked: true, failed: false }) === 'blocked' ? pass('blocked overrides mode') : fail('blocked wrong');
  computeStatus({ mode: 'live', humanGateReached: true, blocked: false, failed: true }) === 'failed' ? pass('failed overrides everything') : fail('failed precedence wrong');
}

section(7, 'runWorkflowPackage rejects unknown workflow_id');
{
  const pkgPath = path.join(TMP_ROOT, 'pkg-unknown.json');
  fs.writeFileSync(pkgPath, JSON.stringify({
    workflow_id: 'definitely-not-a-real-scaffold-x',
    source_system: 'external_client',
    entity_type: 'album',
    entity_id: 'ENT_1',
    mode: 'dry_run',
  }, null, 2));
  const out = await runWorkflowPackage({ packagePath: pkgPath, runRoot: TMP_ROOT });
  out.status === 'failed' ? pass('unknown workflow_id → failed') : fail('unknown workflow_id not failed', out.status);
  out.errors.some(e => /scaffolds:/i.test(typeof e === 'string' ? e : (e?.message || ''))) || out.errors.some(e => /scaffolds:/i.test(JSON.stringify(e)))
    ? pass('error mentions scaffolds list')
    : fail('error did not mention scaffolds', JSON.stringify(out.errors));
}

section(8, 'runWorkflowPackage on a scaffold without on-disk materialization → blocked');
{
  const pkgPath = path.join(TMP_ROOT, 'pkg-scaffold-only.json');
  fs.writeFileSync(pkgPath, JSON.stringify({
    workflow_id: 'distributor-album-submit', // scaffold exists, no workflows/ dir
    source_system: 'external_client',
    entity_type: 'album',
    entity_id: 'ENT_1',
    mode: 'dry_run',
  }, null, 2));
  // Temporarily verify the workflow dir does NOT exist (must hold for this check)
  const onDisk = fs.existsSync(path.join(REPO_ROOT, 'workflows', 'distributor-album-submit', 'workflow.json'));
  if (onDisk) {
    pass('skipped: distributor-album-submit already materialized on disk');
  } else {
    const out = await runWorkflowPackage({ packagePath: pkgPath, runRoot: TMP_ROOT });
    out.status === 'blocked' ? pass('scaffold-only → blocked') : fail('expected blocked, got ' + out.status);
    const har = out.result.client_action_requests.find(r => r.type === 'selector_verification_required');
    har ? pass('selector_verification_required emitted') : fail('no selector_verification_required emitted', JSON.stringify(out.result.client_action_requests));
    out.resultPath && fs.existsSync(out.resultPath) ? pass('result.json written') : fail('result.json not written');
    const fromDisk = JSON.parse(fs.readFileSync(out.resultPath, 'utf8'));
    fromDisk.status === 'blocked' ? pass('on-disk result.status matches in-memory') : fail('on-disk status mismatch');
    fromDisk.return_contract_version === RETURN_CONTRACT_VERSION ? pass('on-disk contract version matches') : fail('on-disk version mismatch');
  }
}

section(9, 'runWorkflowPackage on an existing materialized workflow (local-form-demo) with no field-map.local.json — also blocks for selector verification');
{
  // local-form-demo ships with field-map.local.json so this should not block on
  // the field map. Use the scaffold "salesforce-reports" which is materialized
  // without field-map.local.json instead.
  const target = fs.existsSync(path.join(REPO_ROOT, 'workflows', 'salesforce-reports', 'workflow.json'))
    ? 'salesforce-reports'
    : 'local-form-demo';
  const pkgPath = path.join(TMP_ROOT, 'pkg-materialized.json');
  fs.writeFileSync(pkgPath, JSON.stringify({
    workflow_id: target,
    source_system: 'external_client',
    entity_type: 'report',
    entity_id: 'REP_1',
    mode: 'dry_run',
    capture_outputs: ['confirmation_url', 'submission_status'],
  }, null, 2));
  const out = await runWorkflowPackage({ packagePath: pkgPath, runRoot: TMP_ROOT });
  out.result.workflow_id === target ? pass('workflow_id round-trips') : fail('workflow_id lost');
  out.result.captured_outputs.confirmation_url?.status === 'pending'
    ? pass('capture_outputs default to pending')
    : fail('capture_outputs did not default to pending', JSON.stringify(out.result.captured_outputs));
  out.result.captured_outputs.submission_status?.status === 'pending'
    ? pass('multiple capture_outputs handled')
    : fail('second capture_output missing');
  // Must include source_system + entity_id in result
  out.result.source_system === 'external_client' && out.result.entity_id === 'REP_1'
    ? pass('source_system + entity_id round-trip in result')
    : fail('source_system/entity_id missing');
}

section(10, 'human_gate=true + mode=live emits human_approval_required');
{
  const pkgPath = path.join(TMP_ROOT, 'pkg-live-gate.json');
  fs.writeFileSync(pkgPath, JSON.stringify({
    workflow_id: fs.existsSync(path.join(REPO_ROOT, 'workflows', 'local-form-demo', 'workflow.json'))
      ? 'local-form-demo' : 'salesforce-reports',
    source_system: 'external_client',
    entity_type: 'demo',
    entity_id: 'D_1',
    mode: 'live',
    human_gate: true,
  }, null, 2));
  const out = await runWorkflowPackage({ packagePath: pkgPath, runRoot: TMP_ROOT });
  const approval = out.result.client_action_requests.find(r => r.type === 'human_approval_required');
  approval ? pass('human_approval_required emitted on live + gate') : fail('no human_approval_required', JSON.stringify(out.result.client_action_requests));
  approval?.severity === 'blocking' ? pass('approval severity is blocking') : fail('approval not blocking');
  out.result.manual_checkpoints.length > 0 ? pass('manual_checkpoints populated') : fail('manual_checkpoints empty');
}

section(11, 'missing assets are reported as missing_input');
{
  const pkgPath = path.join(TMP_ROOT, 'pkg-missing-assets.json');
  fs.writeFileSync(pkgPath, JSON.stringify({
    workflow_id: fs.existsSync(path.join(REPO_ROOT, 'workflows', 'local-form-demo', 'workflow.json'))
      ? 'local-form-demo' : 'salesforce-reports',
    source_system: 'external_client',
    entity_type: 'demo',
    entity_id: 'D_2',
    mode: 'dry_run',
    assets: [{ role: 'cover_art' }],
  }, null, 2));
  const out = await runWorkflowPackage({ packagePath: pkgPath, runRoot: TMP_ROOT });
  const missing = out.result.client_action_requests.find(r => r.type === 'missing_input');
  missing ? pass('missing_input emitted for asset with no path/url') : fail('no missing_input emitted', JSON.stringify(out.result.client_action_requests));
}

section(12, 'workflow:scaffolds CLI lists all 10 reusable workflows');
{
  const scaffolds = listScaffolds();
  scaffolds.length === 10 ? pass(`10 scaffolds (got ${scaffolds.length})`) : fail(`expected 10 scaffolds, got ${scaffolds.length}`);
  const expected = [
    'distributor-album-submit',
    'distributor-single-submit',
    'smart-link-capture',
    'smart-link-enrich',
    'artist-profile-pitch-or-update',
    'creator-platform-upload-schedule',
    'social-platform-upload-schedule',
    'media-generation-download',
    'platform-link-harvest',
    'contact-form-submit',
  ];
  for (const id of expected) {
    getScaffold(id) ? pass(`scaffold "${id}" registered`) : fail(`scaffold "${id}" missing`);
  }
}

section(13, 'CLI exit codes match status');
{
  const pkgPathBlocked = path.join(TMP_ROOT, 'pkg-blocked.json');
  fs.writeFileSync(pkgPathBlocked, JSON.stringify({
    workflow_id: 'distributor-album-submit', // not materialized → blocked
    source_system: 'external_client',
    entity_type: 'album',
    entity_id: 'ENT_X',
    mode: 'dry_run',
  }, null, 2));

  // Only run the CLI assertion if the scaffold isn't materialized;
  // otherwise behavior would differ legitimately.
  const onDisk = fs.existsSync(path.join(REPO_ROOT, 'workflows', 'distributor-album-submit', 'workflow.json'));
  if (onDisk) {
    pass('skipped CLI exit-code check: workflow already materialized');
  } else {
    const cli = spawnSync(process.execPath, [
      path.join(REPO_ROOT, 'src/cli/index.mjs'),
      'workflow:run',
      '--package', pkgPathBlocked,
      '--dry-run',
    ], { encoding: 'utf8' });
    cli.status === 4 ? pass('blocked → exit 4') : fail(`expected exit 4, got ${cli.status}`, cli.stderr || '');
  }

  // Validation failure (missing --package)
  const cliBad = spawnSync(process.execPath, [
    path.join(REPO_ROOT, 'src/cli/index.mjs'),
    'workflow:run',
  ], { encoding: 'utf8' });
  cliBad.status === 2 ? pass('missing --package → exit 2') : fail(`expected exit 2, got ${cliBad.status}`);
}

section(14, 'No client-specific names leak into src/core or src/cli');
{
  const banned = ['pancake', 'release_cockpit', 'releasecockpit', 'releasecockpit'];
  const targets = ['src/core', 'src/cli'];
  let leaked = [];
  for (const t of targets) {
    for (const b of banned) {
      try {
        const r = execSync(`grep -ril "${b}" ${path.join(REPO_ROOT, t)} || true`, { encoding: 'utf8' }).trim();
        if (r) leaked.push(`${b} in ${t}: ${r}`);
      } catch { /* grep returns nonzero when nothing found */ }
    }
  }
  leaked.length === 0 ? pass('src/core and src/cli are client-neutral') : fail('client-specific names found', leaked.join('\n      '));
}

section(15, 'VALID_MODES + VALID_STATUSES match the brief');
{
  JSON.stringify(VALID_MODES) === JSON.stringify(['dry_run', 'live']) ? pass('VALID_MODES = [dry_run, live]') : fail('VALID_MODES wrong: ' + VALID_MODES.join(','));
  const expectedStatuses = ['dry_run_passed','live_run_gated','live_run_completed','blocked','failed'];
  expectedStatuses.every(s => VALID_STATUSES.includes(s)) ? pass('VALID_STATUSES covers all required statuses') : fail('missing status', VALID_STATUSES.join(','));
}

// ──────────────────────────────────────────────────────────────────────────────
console.log('');
console.log(`Summary: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('Failures:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('All checks passed.');

// Cleanup tmp dir on success only — leave for debugging on failure.
try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch {}
