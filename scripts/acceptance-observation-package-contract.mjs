#!/usr/bin/env node
/**
 * Acceptance test: observation-derived workflow package conforms to the
 * runtime workflow package contract.
 *
 * Background: prior to this test, buildWorkflowPackageFromObservation emitted a
 * stale shape (schemaVersion / workflowId / globals / assets-as-object /
 * repeatGroups at the top level), and the on-disk
 * workflows/observed-workflow/workflow-package.example.json carried that shape.
 * `npm run workflow:run -- --package … --dry-run` then failed with six
 * package-contract errors before the runner ever reached the workflow.
 *
 * This script proves the regression cannot return:
 *   - the generator emits all required envelope fields
 *     (workflow_id, source_system, entity_type, entity_id, mode)
 *   - `assets` is an array, never an id→path object
 *   - validateWorkflowPackage accepts the emitted package
 *   - the materialized workflows/observed-workflow/workflow-package.example.json
 *     also validates and dry-runs without contract errors (it may legitimately
 *     block on selector_verification_required — that is a workflow-state
 *     concern, not a package-contract concern)
 *
 * Usage:
 *   node scripts/acceptance-observation-package-contract.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  validateWorkflowPackage,
  loadWorkflowPackage,
  RETURN_CONTRACT_VERSION,
} from '../src/core/workflow-contract.mjs';
import { runWorkflowPackage } from '../src/core/workflow-run.mjs';
import {
  normalizeObservation,
  buildWorkflowPackageFromObservation,
} from '../src/core/observation-ingestion.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'observation-pkg-contract-'));

let passed = 0, failed = 0;
const failures = [];
function pass(label) { console.log('PASS  ' + label); passed++; }
function fail(label, detail = '') {
  console.error('FAIL  ' + label + (detail ? '\n      ' + detail : ''));
  failed++; failures.push(label);
}
function section(n, title) { console.log(`\n── Check ${n}: ${title} ──`); }

const REQUIRED_ENVELOPE = ['workflow_id', 'source_system', 'entity_type', 'entity_id', 'mode'];

// ─────────────────────────────────────────────────────────────────────────────
section(1, 'buildWorkflowPackageFromObservation emits all required envelope fields');
{
  const fixture = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'fixtures', 'observed-album-workflow', 'observation.json'), 'utf8'));
  const pkg = buildWorkflowPackageFromObservation(fixture);
  for (const key of REQUIRED_ENVELOPE) {
    (typeof pkg[key] === 'string' && pkg[key].length > 0)
      ? pass(`pkg.${key} = "${pkg[key]}"`)
      : fail(`pkg.${key} missing or empty`, JSON.stringify(pkg[key]));
  }
  pkg.return_contract_version === RETURN_CONTRACT_VERSION
    ? pass(`return_contract_version = "${RETURN_CONTRACT_VERSION}"`)
    : fail('wrong return_contract_version', String(pkg.return_contract_version));
}

// ─────────────────────────────────────────────────────────────────────────────
section(2, 'buildWorkflowPackageFromObservation emits assets as an ARRAY (never an id→path object)');
{
  const fixture = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'fixtures', 'observed-album-workflow', 'observation.json'), 'utf8'));
  const pkg = buildWorkflowPackageFromObservation(fixture);
  Array.isArray(pkg.assets)
    ? pass('pkg.assets is an array')
    : fail(`pkg.assets must be an array, got ${typeof pkg.assets}`, JSON.stringify(pkg.assets));
  // Every entry must be a { role, path? | url? } object — not a stringly key.
  for (const a of pkg.assets) {
    (a && typeof a === 'object' && typeof a.role === 'string')
      ? pass(`asset entry has role="${a.role}"`)
      : fail('asset entry missing role', JSON.stringify(a));
  }
  // The fixture has both a global asset (albumCover) and a per-repeat-item asset
  // (audioFile within tracks group). Both must round-trip.
  pkg.assets.find(a => a.role === 'albumCover')
    ? pass('global asset "albumCover" present in array')
    : fail('global asset "albumCover" missing', JSON.stringify(pkg.assets));
  pkg.assets.find(a => a.role === 'audioFile' && a.repeat_group === 'tracks')
    ? pass('per-item asset "audioFile" carries repeat_group="tracks"')
    : fail('per-item asset audioFile missing or unscoped', JSON.stringify(pkg.assets));
}

// ─────────────────────────────────────────────────────────────────────────────
section(3, 'generator output passes the runtime validateWorkflowPackage');
{
  const fixture = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'fixtures', 'observed-album-workflow', 'observation.json'), 'utf8'));
  const pkg = buildWorkflowPackageFromObservation(fixture);
  const v = validateWorkflowPackage(pkg);
  v.ok
    ? pass('validateWorkflowPackage(pkg).ok === true')
    : fail('validateWorkflowPackage rejected the observation-derived package', JSON.stringify(v.errors));
}

// ─────────────────────────────────────────────────────────────────────────────
section(4, 'minimal observation (no fields/assets/repeats) still produces a contract-valid package');
{
  const minimal = normalizeObservation({ title: 'Bare Workflow' });
  const pkg = buildWorkflowPackageFromObservation(minimal);
  for (const key of REQUIRED_ENVELOPE) {
    (typeof pkg[key] === 'string' && pkg[key].length > 0)
      ? pass(`bare pkg.${key} = "${pkg[key]}"`)
      : fail(`bare pkg.${key} missing`, JSON.stringify(pkg[key]));
  }
  Array.isArray(pkg.assets)
    ? pass('bare pkg.assets is an array (empty allowed)')
    : fail('bare pkg.assets must be an array', JSON.stringify(pkg.assets));
  const v = validateWorkflowPackage(pkg);
  v.ok ? pass('bare package validates') : fail('bare package rejected', JSON.stringify(v.errors));
}

// ─────────────────────────────────────────────────────────────────────────────
section(5, 'materializing an observation writes a workflow-package.example.json that validates');
{
  const fixture = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'fixtures', 'observed-album-workflow', 'observation.json'), 'utf8'));
  const obs = normalizeObservation(fixture);
  const pkg = buildWorkflowPackageFromObservation(obs);
  // Mimic the wizard's /api/observation/import write step — persist the
  // package next to a workflow.json and re-load via loadWorkflowPackage so we
  // exercise the same JSON round-trip the runtime uses.
  const wfDir = path.join(TMP_ROOT, 'workflows', obs.workflowId);
  fs.mkdirSync(wfDir, { recursive: true });
  const pkgPath = path.join(wfDir, 'workflow-package.example.json');
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

  const loaded = loadWorkflowPackage(pkgPath);
  loaded.ok
    ? pass(`loadWorkflowPackage accepts the on-disk file`)
    : fail('loadWorkflowPackage rejected on-disk observation package', JSON.stringify(loaded.errors));

  // Re-verify the on-disk envelope explicitly.
  const onDisk = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  REQUIRED_ENVELOPE.every(k => typeof onDisk[k] === 'string' && onDisk[k].length > 0)
    ? pass('on-disk package has every required envelope field')
    : fail('on-disk package missing required field', JSON.stringify(Object.keys(onDisk)));
  Array.isArray(onDisk.assets)
    ? pass('on-disk assets is an array')
    : fail('on-disk assets is not an array', JSON.stringify(onDisk.assets));
}

// ─────────────────────────────────────────────────────────────────────────────
section(6, 'workflows/observed-workflow/workflow-package.example.json no longer fails on package-contract validation');
{
  const onDiskPkgPath = path.join(REPO_ROOT, 'workflows', 'observed-workflow', 'workflow-package.example.json');
  if (!fs.existsSync(onDiskPkgPath)) {
    fail('observed-workflow example missing', onDiskPkgPath);
  } else {
    const loaded = loadWorkflowPackage(onDiskPkgPath);
    loaded.ok
      ? pass('observed-workflow example loads + validates against the contract')
      : fail('observed-workflow example failed contract validation', JSON.stringify(loaded.errors));

    // Run end-to-end through the runner. Result may be `blocked` for
    // selector_verification_required (workflow lacks field-map.local.json) —
    // that is fine. What MUST NOT happen is a `failed` status with
    // package-contract errors.
    const out = await runWorkflowPackage({ packagePath: onDiskPkgPath, modeOverride: 'dry_run', runRoot: TMP_ROOT });
    out.status !== 'failed'
      ? pass(`dry-run status is "${out.status}" (not "failed" — package contract is satisfied)`)
      : fail('dry-run still fails on package contract', JSON.stringify(out.errors));

    const contractErrors = (out.errors || []).filter(e => {
      const msg = typeof e === 'string' ? e : (e?.message || JSON.stringify(e));
      return /^package\.(workflow_id|source_system|entity_type|entity_id|mode|assets)\b/.test(msg);
    });
    contractErrors.length === 0
      ? pass('no "package.<field> is required …" errors in dry-run output')
      : fail('package-contract errors still present', JSON.stringify(contractErrors));
  }
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
