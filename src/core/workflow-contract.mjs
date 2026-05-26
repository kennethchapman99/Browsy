// Browsy generic workflow package + result contracts.
//
// A "workflow package" is the request a client submits to Browsy. Browsy validates
// it, runs (or dry-runs) the named reusable workflow, and writes a normalized
// "automation result" JSON the client consumes.
//
// Browsy is a harness factory. It must not embed any client-specific business
// logic (release lifecycle, campaign semantics, brand concepts, DB writes).
// All client context flows in through `source_system`, `entity_type`, `entity_id`,
// `canonical_payload`, and `assets` — Browsy stays generic.
//
// See docs/workflow-package-contract.md and docs/automation-result-contract.md.

import fs from 'fs';
import path from 'path';

export const RETURN_CONTRACT_VERSION = 'automation-result-v1';

// Workflow execution mode.
//   dry_run — no browser side-effects beyond safe inspection
//   live    — execute deterministic steps; still stop at every human gate
export const VALID_MODES = ['dry_run', 'live'];

// Status values written to result.json. Clients should branch on these.
//   dry_run_passed       — dry-run completed without violating safety policy
//   live_run_gated       — live execution paused at a human gate; nothing dangerous was clicked
//   live_run_completed   — live execution finished and all human gates were satisfied
//   blocked              — execution stopped because of a safety violation, missing input, or unverified selector
//   failed               — execution hit an unexpected error
//   stopped_by_user      — the operator pressed STOP from the UI before the run could finish
export const VALID_STATUSES = [
  'dry_run_passed',
  'live_run_gated',
  'live_run_completed',
  'blocked',
  'failed',
  'stopped_by_user',
];

// What to do when a workflow can't make safe progress.
//   stop_and_return_blocked_result — default; never retry blindly
export const VALID_ON_FAILURE = ['stop_and_return_blocked_result'];

// ---------------------------------------------------------------------------
// Package validation
// ---------------------------------------------------------------------------

// Validate a workflow package object. Returns { ok, errors[] }.
// Errors are strings; callers should surface all of them, not just the first.
export function validateWorkflowPackage(pkg) {
  const errors = [];

  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) {
    return { ok: false, errors: ['package must be a JSON object'] };
  }

  // Required strings
  for (const key of ['workflow_id', 'source_system', 'entity_type', 'entity_id', 'mode']) {
    if (typeof pkg[key] !== 'string' || !pkg[key].trim()) {
      errors.push(`package.${key} is required and must be a non-empty string`);
    }
  }

  if (pkg.mode && !VALID_MODES.includes(pkg.mode)) {
    errors.push(`package.mode must be one of ${VALID_MODES.join(', ')} (got "${pkg.mode}")`);
  }

  if ('human_gate' in pkg && typeof pkg.human_gate !== 'boolean') {
    errors.push('package.human_gate must be a boolean when present');
  }

  if (pkg.manifest_path != null && typeof pkg.manifest_path !== 'string') {
    errors.push('package.manifest_path must be a string when present');
  }

  if ('canonical_payload' in pkg
      && (pkg.canonical_payload == null || typeof pkg.canonical_payload !== 'object' || Array.isArray(pkg.canonical_payload))) {
    errors.push('package.canonical_payload must be an object when present');
  }

  if ('assets' in pkg && !Array.isArray(pkg.assets)) {
    errors.push('package.assets must be an array when present');
  }

  if ('capture_outputs' in pkg) {
    if (!Array.isArray(pkg.capture_outputs)) {
      errors.push('package.capture_outputs must be an array of strings when present');
    } else if (pkg.capture_outputs.some(o => typeof o !== 'string' || !o.trim())) {
      errors.push('package.capture_outputs must contain only non-empty strings');
    }
  }

  if ('on_failure' in pkg && !VALID_ON_FAILURE.includes(pkg.on_failure)) {
    errors.push(`package.on_failure must be one of ${VALID_ON_FAILURE.join(', ')} (got "${pkg.on_failure}")`);
  }

  if ('return_contract_version' in pkg && pkg.return_contract_version !== RETURN_CONTRACT_VERSION) {
    errors.push(
      `package.return_contract_version must be "${RETURN_CONTRACT_VERSION}" (got "${pkg.return_contract_version}")`
    );
  }

  // Safety: refuse anything obviously client-private leaking into the contract.
  // (Browsy is generic; do not let clients smuggle in DB writes.)
  for (const forbidden of ['db_write', 'database_write', 'sql', 'connection_string']) {
    if (forbidden in pkg) {
      errors.push(`package.${forbidden} is not supported — Browsy does not perform direct DB writes`);
    }
  }

  return { ok: errors.length === 0, errors };
}

// Load and parse a workflow package from disk, then validate it.
// Returns { ok, errors, pkg, packagePath }.
export function loadWorkflowPackage(packagePath) {
  if (!packagePath) {
    return { ok: false, errors: ['--package is required'], pkg: null, packagePath: null };
  }
  const abs = path.resolve(packagePath);
  if (!fs.existsSync(abs)) {
    return { ok: false, errors: [`package file not found: ${abs}`], pkg: null, packagePath: abs };
  }
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    return { ok: false, errors: [`invalid JSON in package: ${e.message}`], pkg: null, packagePath: abs };
  }
  const v = validateWorkflowPackage(pkg);
  return { ok: v.ok, errors: v.errors, pkg, packagePath: abs };
}

// ---------------------------------------------------------------------------
// Result builder
// ---------------------------------------------------------------------------

// Make a new in-memory result skeleton populated from the package.
// Callers mutate fields on it during the run and pass it to finalizeResult.
export function newResult({ pkg, runId }) {
  return {
    ok: true,
    workflow_id: pkg.workflow_id,
    run_id: runId,
    source_system: pkg.source_system,
    entity_type: pkg.entity_type,
    entity_id: pkg.entity_id,
    status: null,
    captured_outputs: {},
    downloaded_files: [],
    filled_fields: [],
    skipped_fields: [],
    errors: [],
    screenshots: [],
    artifact_paths: [],
    manual_checkpoints: [],
    client_action_requests: [],
    next_required_action: null,
    return_contract_version: RETURN_CONTRACT_VERSION,
    generated_at: new Date().toISOString(),
  };
}

// Validate a populated result before writing it to disk.
// Returns { ok, errors[] }.
export function validateResult(result) {
  const errors = [];
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { ok: false, errors: ['result must be a JSON object'] };
  }
  for (const key of ['workflow_id', 'run_id', 'source_system', 'entity_type', 'entity_id', 'status']) {
    if (typeof result[key] !== 'string' || !result[key].trim()) {
      errors.push(`result.${key} is required and must be a non-empty string`);
    }
  }
  if (result.status && !VALID_STATUSES.includes(result.status)) {
    errors.push(`result.status must be one of ${VALID_STATUSES.join(', ')} (got "${result.status}")`);
  }
  if (typeof result.ok !== 'boolean') errors.push('result.ok must be a boolean');
  if (!result.captured_outputs || typeof result.captured_outputs !== 'object' || Array.isArray(result.captured_outputs)) {
    errors.push('result.captured_outputs must be an object');
  }
  for (const arrKey of ['filled_fields', 'skipped_fields', 'errors', 'screenshots', 'artifact_paths', 'manual_checkpoints', 'client_action_requests']) {
    if (!Array.isArray(result[arrKey])) errors.push(`result.${arrKey} must be an array`);
  }
  if (result.return_contract_version !== RETURN_CONTRACT_VERSION) {
    errors.push(`result.return_contract_version must be "${RETURN_CONTRACT_VERSION}"`);
  }
  return { ok: errors.length === 0, errors };
}

// Construct a single client_action_request entry.
// Use this rather than building the object inline so the shape stays consistent.
//
//   type           — 'human_decision_required' | 'human_approval_required'
//                    | 'selector_verification_required' | 'missing_input'
//                    | 'unverified_capture' | 'safety_block'
//   severity       — 'blocking' | 'advisory'
//   reason         — human-readable explanation
//   suggested_action — what the client should do next
//   related_field  — optional field name this is about
//   related_item_id — optional repeat-group item id this is about
export function clientActionRequest({ type, severity, reason, suggested_action, related_field, related_item_id, ...extra }) {
  const out = { type, severity, reason, suggested_action };
  if (related_field) out.related_field = related_field;
  if (related_item_id) out.related_item_id = related_item_id;
  return { ...out, ...extra };
}

// Compute a status from the in-flight result + mode.
// Call this immediately before writeResult so status reflects the final state.
//
//   mode — 'dry_run' | 'live'
//   humanGateReached — true if execution paused at a safety checkpoint
//   blocked — true if execution stopped for safety/missing input/unverified selector
//   failed  — true if an unexpected error occurred
export function computeStatus({ mode, humanGateReached, blocked, failed }) {
  if (failed) return 'failed';
  if (blocked) return 'blocked';
  if (mode === 'dry_run') return 'dry_run_passed';
  if (humanGateReached) return 'live_run_gated';
  return 'live_run_completed';
}
