// Run executor for the registry layer.
//
// Responsibility chain:
//   1. Validate payload against inputSchema             → fail closed before browser launch
//   2. Check safety gates (mode, approvalToken, etc.)   → fail closed before browser launch
//   3. Execute via runWorkflowPackage (existing engine) → captures processStatus
//   4. Evaluate assertions                              → determines workflowOutcome
//   5. Update run record with results + artifacts

import { join } from 'path';
import { REGISTRY_DIR, ensureDir, exists, readJson, writeJson } from '../core/paths.mjs';
import { validatePayload, evaluateAssertions } from './schema-validator.mjs';
import { checkSafetyGates, toInternalMode } from './safety-gates.mjs';
import { updateRun, addArtifact } from './run-registry.mjs';
import { runWorkflowPackage } from '../core/workflow-run.mjs';

// Execute a registry run end-to-end.
//
// Params:
//   runId          — the pre-created run ID
//   workflowVersion — the full workflow version record from workflow-registry
//   payload        — caller-supplied input payload
//   mode           — 'preview' | 'live' | 'discover' | 'repair'
//   approvalToken  — required for live mode (any non-empty string)
//   runRoot        — optional override for run output root (testing)
//
// Returns the final run record.
export async function executeRun({ runId, workflowVersion, payload, mode, approvalToken, runRoot }) {
  const now = () => new Date().toISOString();

  // ── 1. Payload validation ──────────────────────────────────────────────────
  const { ok: payloadOk, errors: payloadErrors } = validatePayload(
    payload,
    workflowVersion.inputSchema
  );
  if (!payloadOk) {
    return updateRun(runId, {
      processStatus: 'rejected',
      workflowOutcome: 'failed',
      completedAt: now(),
      validationErrors: payloadErrors,
    });
  }

  // ── 2. Safety gates ────────────────────────────────────────────────────────
  const { ok: gateOk, errors: gateErrors } = checkSafetyGates({
    workflowVersion,
    mode,
    approvalToken,
  });
  if (!gateOk) {
    return updateRun(runId, {
      processStatus: 'rejected',
      workflowOutcome: 'failed',
      completedAt: now(),
      validationErrors: gateErrors,
    });
  }

  // ── 3. Build (or load) a workflow package for the existing engine ──────────
  const internalMode = toInternalMode(mode);
  const stopBeforeSubmit = mode === 'preview';

  const registryRunDir = runRoot
    ? join(runRoot, 'runs', runId)
    : join(REGISTRY_DIR, 'runs', runId);
  ensureDir(registryRunDir);
  const pkgPath = join(registryRunDir, 'package.json');

  // When the workflow version was imported from a real package directory, try to
  // use the execution package file from that directory. This wires the registry
  // run to the real Browsy workflow execution engine rather than a synthetic stub.
  let pkgToWrite = null;

  if (workflowVersion.packagePath) {
    for (const f of ['workflow-package.local.json', 'workflow-package.example.json']) {
      const candidate = join(workflowVersion.packagePath, f);
      if (exists(candidate)) {
        try {
          const realPkg = readJson(candidate);
          pkgToWrite = {
            ...realPkg,
            // Override payload and mode from the registry run so callers' input
            // takes precedence over the example values baked into the package file.
            canonical_payload: payload,
            mode: internalMode,
            human_gate: stopBeforeSubmit || mode === 'live',
          };
        } catch { /* fall through to synthetic */ }
        break;
      }
    }
  }

  if (!pkgToWrite) {
    // Synthetic package: use packageWorkflowId when set so runWorkflowPackage can
    // resolve the workflow directory on disk. Falls back to workflowObjectId for
    // workflows registered without an imported package (prior behaviour).
    pkgToWrite = {
      workflow_id: workflowVersion.packageWorkflowId || workflowVersion.workflowObjectId,
      source_system: 'registry',
      entity_type: workflowVersion.appId,
      entity_id: runId,
      mode: internalMode,
      human_gate: stopBeforeSubmit || mode === 'live',
      canonical_payload: payload,
      assets: [],
      capture_outputs: [],
      return_contract_version: 'automation-result-v1',
      on_failure: 'stop_and_return_blocked_result',
    };
  }

  writeJson(pkgPath, pkgToWrite);

  let engineResult = null;
  let processStatus = 'failed';

  try {
    const outcome = await runWorkflowPackage({
      packagePath: pkgPath,
      runRoot: runRoot || join(REGISTRY_DIR, '_engine_runs'),
    });
    engineResult = outcome.result;

    // Any engine result (including blocked/dry_run_passed) means the process completed
    // its job. The workflowOutcome is determined separately by assertions.
    // Only a thrown exception causes processStatus='failed'.
    processStatus = 'completed';
  } catch (err) {
    return updateRun(runId, {
      processStatus: 'failed',
      workflowOutcome: 'failed',
      completedAt: now(),
      validationErrors: [`execution error: ${err.message}`],
    });
  }

  // ── 4. Assertions ──────────────────────────────────────────────────────────
  const assertionResults = evaluateAssertions(
    workflowVersion.successAssertions || [],
    workflowVersion.failureAssertions || [],
    engineResult || {}
  );
  const workflowOutcome = processStatus === 'failed' ? 'failed' : assertionResults.outcome;

  // ── 5. Collect artifacts ───────────────────────────────────────────────────
  const artifacts = [];
  if (engineResult?.artifact_paths?.length) {
    for (const ap of engineResult.artifact_paths) {
      artifacts.push({ name: ap.split('/').pop(), path: ap, type: 'file' });
    }
  }
  // Save the engine result as an artifact.
  const engineResultPath = join(registryRunDir, 'engine-result.json');
  writeJson(engineResultPath, engineResult || {});
  artifacts.push({ name: 'engine-result.json', path: engineResultPath, type: 'json' });

  return updateRun(runId, {
    processStatus,
    workflowOutcome,
    completedAt: now(),
    artifacts,
    assertionResults,
    internalRunResult: engineResult,
  });
}
