// Browsy generic workflow runner.
//
// Reads a workflow package (see workflow-contract.mjs), loads the named workflow,
// runs it (or dry-runs it) through the existing Browsy primitives, and writes a
// normalized result.json at output/runs/<workflow_id>/<timestamp>/result.json.
//
// This runner is the only place that needs to know about both contracts. Reusable
// workflows themselves stay declarative — they live under workflows/<id>/ and
// expose a manifest schema, a field map, and a safety policy.

import fs from 'fs';
import path from 'path';
import {
  loadWorkflowPackage,
  newResult,
  validateResult,
  clientActionRequest,
  computeStatus,
  RETURN_CONTRACT_VERSION,
} from './workflow-contract.mjs';
import {
  OUTPUT_DIR,
  WORKFLOWS_DIR,
  ensureDir,
  exists,
  readJson,
  writeJson,
} from './paths.mjs';
import { defaultSafetyPolicy, isDangerousText } from './safety.mjs';
import { listScaffolds, getScaffold } from './workflow-scaffolds.mjs';

// Run a workflow package end-to-end.
//
//   options.packagePath  — absolute path to the package JSON
//   options.workflowId   — optional override for pkg.workflow_id (CLI --workflow flag)
//   options.modeOverride — optional override: 'dry_run' | 'live'
//   options.runRoot      — optional override for output root (testing)
//
// Returns { ok, status, resultPath, result, errors }.
// `ok` is true if Browsy executed the workflow per its safety contract, even when
// the workflow itself paused at a human gate. It is false only on validation
// errors or unexpected execution failures.
export async function runWorkflowPackage(options = {}) {
  const { packagePath, workflowId: workflowIdOverride, modeOverride, runRoot } = options;

  // 1. Load + validate package
  const loaded = loadWorkflowPackage(packagePath);
  if (!loaded.ok) {
    return { ok: false, status: 'failed', resultPath: null, result: null, errors: loaded.errors };
  }
  const pkg = loaded.pkg;

  // Apply CLI overrides
  if (workflowIdOverride) pkg.workflow_id = workflowIdOverride;
  if (modeOverride) pkg.mode = modeOverride;

  // 2. Resolve workflow project
  const scaffold = getScaffold(pkg.workflow_id);
  const workflowDir = path.join(WORKFLOWS_DIR, pkg.workflow_id);
  const workflowExists = exists(workflowDir) && exists(path.join(workflowDir, 'workflow.json'));
  if (!workflowExists && !scaffold) {
    return {
      ok: false,
      status: 'failed',
      resultPath: null,
      result: null,
      errors: [
        `Unknown workflow_id "${pkg.workflow_id}". ` +
        `Either scaffold it under workflows/${pkg.workflow_id}/ (npm run init:workflow -- --id ${pkg.workflow_id}) ` +
        `or pick one of the reusable scaffolds: ${listScaffolds().map(s => s.id).join(', ')}.`,
      ],
    };
  }

  // 3. Prepare run directory and result skeleton
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const baseRunDir = runRoot
    ? path.join(runRoot, 'runs', pkg.workflow_id, timestamp)
    : path.join(OUTPUT_DIR, 'runs', pkg.workflow_id, timestamp);
  ensureDir(baseRunDir);
  const runId = `${pkg.workflow_id}-${timestamp}`;
  const result = newResult({ pkg, runId });

  // 4. Load workflow safety policy if present
  const policyPath = path.join(workflowDir, 'safety-policy.json');
  const policy = exists(policyPath) ? readJson(policyPath) : defaultSafetyPolicy();

  // 5. Resolve canonical payload (inline or file-backed)
  const canonical = await resolveCanonical(pkg, loaded.packagePath, result);

  // 6. Walk capture_outputs — every one starts as pending until proven by the run
  for (const key of pkg.capture_outputs || []) {
    result.captured_outputs[key] = { status: 'pending', value: null };
  }

  // 7. Field-map gate: every workflow must have field-map.local.json before
  //    deterministic browser steps can run. Without it, we report
  //    selector_verification_required and stop.
  const fieldMapPath = path.join(workflowDir, 'field-map.local.json');
  const fieldMapVerified = workflowExists && exists(fieldMapPath);

  let humanGateReached = false;
  let blocked = false;
  let failed = false;

  if (!workflowExists && scaffold) {
    // Workflow is known by name (in the scaffold registry) but not materialized
    // on disk. Report what would be required to enable runs.
    result.client_action_requests.push(clientActionRequest({
      type: 'selector_verification_required',
      severity: 'blocking',
      reason: `Workflow "${pkg.workflow_id}" is a reusable scaffold but has not been materialized under workflows/${pkg.workflow_id}/. Discovery and field-map verification are required before runs.`,
      suggested_action: `npm run init:workflow -- --id ${pkg.workflow_id} && npm run discover -- --workflow ${pkg.workflow_id} --url <discovery-url> --candidates`,
    }));
    result.next_required_action = 'scaffold_and_discover';
    blocked = true;
  } else if (!fieldMapVerified) {
    result.client_action_requests.push(clientActionRequest({
      type: 'selector_verification_required',
      severity: 'blocking',
      reason: `No verified field map at ${path.relative(WORKFLOWS_DIR, fieldMapPath)}. Selectors are unverified and cannot be used for deterministic execution.`,
      suggested_action: `Run discovery and create workflows/${pkg.workflow_id}/field-map.local.json (or npm run discover:map -- --workflow ${pkg.workflow_id}).`,
    }));
    result.next_required_action = 'run_discovery_and_verify_field_map';
    blocked = true;
  }

  // 8. Pre-flight: if mode=live and human_gate is on, surface the gate as
  //    a blocking action_request unless explicitly satisfied (this protects against
  //    accidental clicks at final-action controls).
  const humanGate = pkg.human_gate !== false;
  if (pkg.mode === 'live' && humanGate) {
    humanGateReached = true;
    result.manual_checkpoints.push({
      type: 'final_action_gate',
      reason: 'human_gate=true — Browsy stops at the final-action checkpoint',
      blocked_actions: policy.never_click_text || [],
    });
    result.client_action_requests.push(clientActionRequest({
      type: 'human_approval_required',
      severity: 'blocking',
      reason: 'Final submit/publish/send is a high-impact action and requires human approval inside the target browser session.',
      suggested_action: 'Approve final submit in the open browser session, then re-run with human_gate=false (only if your workflow explicitly supports a live gated path).',
    }));
  }

  // 9. Surface missing required inputs as blocking action requests.
  //    Treat assets with no path or canonical_payload empties as missing.
  if (Array.isArray(pkg.assets)) {
    for (const asset of pkg.assets) {
      const missing = !asset || (typeof asset === 'object' && !asset.path && !asset.url);
      if (missing) {
        result.client_action_requests.push(clientActionRequest({
          type: 'missing_input',
          severity: 'blocking',
          reason: 'Asset entry has neither path nor url.',
          suggested_action: 'Supply asset.path (local file) or asset.url (remote source) in the workflow package.',
          related_field: asset?.role || 'asset',
        }));
        blocked = true;
      }
    }
  }

  // 10. Capture canonical payload + plan into artifacts so reviewers see what
  //     Browsy intended to do without running a browser.
  const payloadPath = path.join(baseRunDir, 'canonical-payload.json');
  writeJson(payloadPath, canonical);
  result.artifact_paths.push(payloadPath);

  // 11. In dry_run mode (default) Browsy never launches a browser. The result
  //     records what would have been attempted plus every blocker we found.
  if (pkg.mode === 'dry_run') {
    // Nothing to execute beyond the analyses above.
  }

  // 11a. Testing-only delay knob. Lets acceptance tests start a run, race the
  //      STOP endpoint against it, and assert the partial result file is
  //      written before the runner finishes. Off (0) in production.
  const delayMs = Number(process.env.BROWSY_RUN_DELAY_MS) || 0;
  if (delayMs > 0) {
    await new Promise(r => setTimeout(r, delayMs));
  }

  // 12. Finalize status
  result.status = computeStatus({
    mode: pkg.mode,
    humanGateReached,
    blocked,
    failed,
  });
  if (result.status === 'failed' || result.status === 'blocked') {
    result.ok = false;
  }

  // 13. Validate result against contract before writing
  const v = validateResult(result);
  if (!v.ok) {
    result.errors.push(...v.errors.map(message => ({ where: 'result_contract', message })));
    result.ok = false;
    result.status = 'failed';
  }

  // 14. Write result.json
  const resultPath = path.join(baseRunDir, 'result.json');
  writeJson(resultPath, result);

  return {
    ok: result.ok,
    status: result.status,
    resultPath,
    result,
    errors: result.errors,
  };
}

// Resolve canonical_payload from inline + manifest_path, attaching any read errors
// to the result as failed items.
async function resolveCanonical(pkg, packagePath, result) {
  let canonical = { ...(pkg.canonical_payload || {}) };

  if (pkg.manifest_path) {
    const manifestAbs = path.isAbsolute(pkg.manifest_path)
      ? pkg.manifest_path
      : path.resolve(path.dirname(packagePath), pkg.manifest_path);
    if (!fs.existsSync(manifestAbs)) {
      result.client_action_requests.push(clientActionRequest({
        type: 'missing_input',
        severity: 'blocking',
        reason: `manifest_path "${pkg.manifest_path}" does not exist (resolved: ${manifestAbs}).`,
        suggested_action: 'Update the workflow package to point at a real manifest, or inline the payload via canonical_payload.',
      }));
    } else {
      try {
        const fileManifest = JSON.parse(fs.readFileSync(manifestAbs, 'utf8'));
        canonical = { ...fileManifest, ...canonical };
        result.artifact_paths.push(manifestAbs);
      } catch (e) {
        result.errors.push({ where: 'manifest_path', message: e.message });
      }
    }
  }

  return canonical;
}

// Re-export the contract version for callers.
export { RETURN_CONTRACT_VERSION };
