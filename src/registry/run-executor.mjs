// Run executor for the registry layer.
//
// Responsibility chain:
//   1. Validate payload against inputSchema             → fail closed before browser launch
//   2. Check safety gates (mode, approvalToken, etc.)   → fail closed before browser launch
//   3. Execute via runWorkflowPackage (existing engine) → captures processStatus
//   4. Evaluate assertions                              → determines workflowOutcome
//   5. Update run record with normalized result + artifacts

import http from 'http';
import https from 'https';
import { join } from 'path';
import { REGISTRY_DIR, ensureDir, exists, readJson, writeJson } from '../core/paths.mjs';
import { validatePayload, evaluateAssertions } from './schema-validator.mjs';
import { checkSafetyGates, toInternalMode } from './safety-gates.mjs';
import { updateRun, getRun } from './run-registry.mjs';
import { buildRunResult } from './run-result.mjs';
import { runWorkflowPackage } from '../core/workflow-run.mjs';

function postJson(url, data) {
  return new Promise((resolve, reject) => {
    if (!url) return resolve({ skipped: true });
    const parsed = new URL(url);
    const body = JSON.stringify(data);
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.request({
      method: 'POST',
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 10000,
    }, res => {
      res.resume();
      res.on('end', () => resolve({ statusCode: res.statusCode }));
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('callback timeout'));
    });
    req.write(body);
    req.end();
  });
}

async function finishRun(runId, updates) {
  const updated = updateRun(runId, updates);
  const result = buildRunResult(updated);
  const final = updateRun(runId, { result });
  if (final.callbackUrl) {
    try {
      await postJson(final.callbackUrl, result);
      return updateRun(runId, { callbackDeliveredAt: new Date().toISOString() });
    } catch (err) {
      return updateRun(runId, { callbackError: err.message });
    }
  }
  return final;
}

// Execute a registry run end-to-end.
export async function executeRun({ runId, workflowVersion, payload, mode, approvalToken, runRoot }) {
  const now = () => new Date().toISOString();

  updateRun(runId, { status: 'running', processStatus: 'running' });

  const { ok: payloadOk, errors: payloadErrors } = validatePayload(
    payload,
    workflowVersion.inputSchema
  );
  if (!payloadOk) {
    return finishRun(runId, {
      status: 'failed',
      processStatus: 'rejected',
      workflowOutcome: 'failed',
      completedAt: now(),
      validationErrors: payloadErrors,
    });
  }

  const { ok: gateOk, errors: gateErrors } = checkSafetyGates({
    workflowVersion,
    mode,
    approvalToken,
  });
  if (!gateOk) {
    return finishRun(runId, {
      status: mode === 'live' ? 'waiting_for_approval' : 'failed',
      processStatus: mode === 'live' ? 'waiting_for_approval' : 'rejected',
      workflowOutcome: mode === 'live' ? 'blocked' : 'failed',
      completedAt: mode === 'live' ? null : now(),
      blockingReason: gateErrors.join('; '),
      validationErrors: gateErrors,
    });
  }

  const authNeeds = Array.isArray(workflowVersion.auth) ? workflowVersion.auth : [];
  const authCheckpoint = authNeeds.find(a => a?.mode === 'human_required' || a?.mode === 'human_required_if_not_authenticated');
  if (authCheckpoint && !approvalToken && mode === 'live') {
    return finishRun(runId, {
      status: 'waiting_for_auth',
      processStatus: 'waiting_for_auth',
      workflowOutcome: 'blocked',
      blockingReason: `auth required for tab ${authCheckpoint.tabId || '(unknown)'}`,
      checkpoints: [
        ...(getRun(runId)?.checkpoints || []),
        { status: 'waiting_for_auth', checkpoint: authCheckpoint, createdAt: now() },
      ],
    });
  }

  const internalMode = toInternalMode(mode);
  const stopBeforeSubmit = mode === 'preview' || mode === 'dry_run';

  const registryRunDir = runRoot
    ? join(runRoot, 'runs', runId)
    : join(REGISTRY_DIR, 'runs', runId);
  ensureDir(registryRunDir);
  const pkgPath = join(registryRunDir, 'package.json');

  let pkgToWrite = null;

  if (workflowVersion.packagePath) {
    for (const f of ['workflow-package.local.json', 'workflow-package.example.json']) {
      const candidate = join(workflowVersion.packagePath, f);
      if (exists(candidate)) {
        try {
          const realPkg = readJson(candidate);
          pkgToWrite = {
            ...realPkg,
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
    processStatus = 'completed';
  } catch (err) {
    return finishRun(runId, {
      status: 'failed',
      processStatus: 'failed',
      workflowOutcome: 'failed',
      completedAt: now(),
      validationErrors: [`execution error: ${err.message}`],
    });
  }

  const assertionResults = evaluateAssertions(
    workflowVersion.successAssertions || [],
    workflowVersion.failureAssertions || [],
    engineResult || {}
  );
  const workflowOutcome = processStatus === 'failed' ? 'failed' : assertionResults.outcome;

  const artifacts = [];
  if (engineResult?.artifact_paths?.length) {
    for (const ap of engineResult.artifact_paths) {
      artifacts.push({ name: ap.split('/').pop(), path: ap, type: 'file' });
    }
  }
  const engineResultPath = join(registryRunDir, 'engine-result.json');
  writeJson(engineResultPath, engineResult || {});
  artifacts.push({ name: 'engine-result.json', path: engineResultPath, type: 'json' });

  const engineStatus = engineResult?.status;
  const waiting = engineStatus === 'live_run_gated' || engineResult?.next_required_action;
  const blocked = engineStatus === 'blocked' || workflowOutcome === 'failed';
  const publicStatus = waiting ? 'waiting_for_approval_to_submit'
    : blocked ? 'blocked'
    : 'completed';

  return finishRun(runId, {
    status: publicStatus,
    processStatus,
    workflowOutcome: publicStatus === 'completed' ? 'success' : workflowOutcome,
    completedAt: waiting ? null : now(),
    artifacts,
    assertionResults,
    internalRunResult: engineResult,
    blockingReason: waiting ? (engineResult?.next_required_action || 'approval required') : null,
  });
}
