// Automation package runner: the full Browsy pipeline in one call.
//
// AUTOMATION_REQUEST.md → parse → validate → run plan → [executor] → artifacts
//
// Returns a structured result with request/manifest/runPlan/execution summaries
// and paths to the written JSON artifact and markdown report.

import fs from 'fs';
import path from 'path';
import { parseRequest } from './request-parser.mjs';
import { buildRunPlan, countStepsByType } from './run-plan.mjs';
import { executeRunPlanWithPlaywright } from './playwright-executor.mjs';
import { REPO_ROOT, ensureDir, writeJson, writeText } from './paths.mjs';

// Run the full automation pipeline.
//
// Options:
//   requestPath   — absolute path to AUTOMATION_REQUEST.md
//   manifestPath  — absolute path to manifest.json
//   targetPath    — absolute path to fixture/page (required in execute mode)
//   mode          — 'fixture' (default)
//   headless      — launch browser headless (default true)
//   dryRun        — skip browser execution (default false)
//   trace         — save Playwright trace (default false)
//   artifactDir   — override artifact output directory (default timestamped under artifacts/)
//
// Returns { ok, mode, dryRun, request, manifest, runPlan, execution, artifacts }
export async function runAutomationPackage({
  requestPath,
  manifestPath,
  targetPath,
  mode = 'fixture',
  headless = true,
  dryRun = false,
  trace = false,
  artifactDir,
} = {}) {
  // 1. Required path checks
  if (!fs.existsSync(requestPath)) {
    throw new Error(`Automation request not found: ${requestPath}`);
  }
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Manifest not found: ${manifestPath}`);
  }

  // 2. Parse request
  const requestText = fs.readFileSync(requestPath, 'utf8');
  const parsed = parseRequest(requestText);
  const validationErrors   = parsed.validationIssues.filter(i => i.level === 'error');
  const validationWarnings = parsed.validationIssues.filter(i => i.level === 'warning');

  const requestSummary = {
    path: requestPath,
    workflowId: parsed.workflowId,
    workflowName: parsed.workflowName,
    validationErrors:   validationErrors.map(e => ({ field: e.field, message: e.message })),
    validationWarnings: validationWarnings.map(w => ({ field: w.field, message: w.message })),
  };

  // 3. Parse manifest
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    throw new Error(`Invalid manifest JSON at ${manifestPath}: ${e.message}`);
  }

  // 4. Build run plan (requires at least one repeat group)
  const rg = parsed.repeatGroups[0];
  if (!rg) {
    throw new Error('No repeat group found in automation request — cannot build run plan.');
  }
  const runPlan = buildRunPlan(rg, manifest);
  const stepCounts = countStepsByType(runPlan);

  const sourceKey = (rg.source || '').replace(/\[\]$/, '');
  const manifestItems = manifest[sourceKey];
  const resolvedItemCount = Array.isArray(manifestItems) ? manifestItems.length : 0;

  const manifestSummary = {
    path: manifestPath,
    itemCount: resolvedItemCount,
  };

  const runPlanSummary = {
    stepCount: runPlan.steps.length,
    globalStepCount:     (stepCounts.fill_global   || 0) + (stepCounts.upload_global || 0),
    itemStepCount:       (stepCounts.fill_item      || 0) + (stepCounts.upload_item   || 0),
    uploadStepCount:     (stepCounts.upload_global  || 0) + (stepCounts.upload_item   || 0),
    checkpointStepCount: (stepCounts.human_checkpoint || 0),
  };

  // 5. Fail early on validation errors — prevents unsafe execution
  if (validationErrors.length > 0) {
    return {
      ok: false,
      mode,
      dryRun,
      error: `Automation request has ${validationErrors.length} validation error(s). Fix them before running.`,
      request: requestSummary,
      manifest: manifestSummary,
      runPlan: runPlanSummary,
      execution: null,
      artifacts: null,
    };
  }

  // 6. Resolve artifact directory
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const resolvedArtifactDir = artifactDir
    || path.join(REPO_ROOT, 'artifacts', 'automation-runs', timestamp);
  ensureDir(resolvedArtifactDir);

  // 7. Execute (or dry-run)
  let execution;
  let executionResult = null;

  if (dryRun) {
    const checkpointStep = runPlan.steps.find(s => s.type === 'human_checkpoint');
    execution = {
      executedStepCount: 0,
      skippedStepCount: 0,
      checkpointReached: !!checkpointStep,
      blockedActions: checkpointStep?.blocked || [],
      executedSteps: [],
      finalState: null,
      error: null,
    };
  } else {
    if (!targetPath || !fs.existsSync(targetPath)) {
      throw new Error(`Target fixture not found: ${targetPath}`);
    }
    const manifestBaseDir = path.dirname(manifestPath);
    executionResult = await executeRunPlanWithPlaywright({
      runPlan,
      fixturePath: targetPath,
      manifestBaseDir,
      headless,
      trace,
    });
    execution = {
      executedStepCount: executionResult.executedSteps.length,
      skippedStepCount:  executionResult.skippedSteps.length,
      checkpointReached: executionResult.checkpoint?.type === 'human_checkpoint',
      blockedActions:    executionResult.checkpoint?.blocked || [],
      executedSteps:     executionResult.executedSteps,
      finalState:        executionResult.finalState,
      error:             executionResult.ok ? null : executionResult.error,
    };
  }

  const ok = dryRun ? true : (executionResult?.ok ?? false);

  // 8. Write artifacts
  const artifactData = {
    ok,
    mode,
    dryRun,
    generatedAt: new Date().toISOString(),
    request: requestSummary,
    manifest: manifestSummary,
    runPlan: runPlanSummary,
    execution,
  };

  const jsonPath     = path.join(resolvedArtifactDir, 'automation-run.json');
  const markdownPath = path.join(resolvedArtifactDir, 'automation-run.md');

  writeJson(jsonPath, artifactData);
  writeText(markdownPath, buildMarkdownReport(artifactData, { requestPath, manifestPath, targetPath }));

  return {
    ok,
    mode,
    dryRun,
    request: requestSummary,
    manifest: manifestSummary,
    runPlan: runPlanSummary,
    execution,
    artifacts: { jsonPath, markdownPath },
  };
}

// Build a human-readable markdown report from the artifact data.
function buildMarkdownReport(artifact, { requestPath, manifestPath, targetPath }) {
  const { request, manifest, runPlan, execution, dryRun, mode } = artifact;
  const lines = [];

  lines.push('# Browsy Automation Run Report');
  lines.push('');
  lines.push(`Generated: ${artifact.generatedAt}`);
  lines.push(`Mode: ${mode}${dryRun ? ' (dry-run)' : ''}`);
  lines.push(`Status: ${artifact.ok ? 'OK' : 'FAILED'}`);
  lines.push('');

  lines.push('## Request');
  lines.push(`- File: \`${requestPath}\``);
  lines.push(`- Workflow: \`${request.workflowId}\` (${request.workflowName})`);
  lines.push('');

  lines.push('## Manifest');
  lines.push(`- File: \`${manifestPath}\``);
  lines.push(`- Items: ${manifest.itemCount}`);
  lines.push('');

  lines.push('## Target');
  lines.push(`- \`${targetPath || '(not specified)'}\``);
  lines.push('');

  lines.push('## Validation Summary');
  if (request.validationErrors.length === 0 && request.validationWarnings.length === 0) {
    lines.push('- No errors or warnings.');
  } else {
    if (request.validationErrors.length > 0) {
      lines.push(`- **${request.validationErrors.length} error(s)**`);
      for (const e of request.validationErrors) {
        lines.push(`  - [${e.field}] ${e.message}`);
      }
    }
    if (request.validationWarnings.length > 0) {
      lines.push(`- ${request.validationWarnings.length} warning(s)`);
      for (const w of request.validationWarnings) {
        lines.push(`  - [${w.field}] ${w.message}`);
      }
    }
  }
  lines.push('');

  lines.push('## Run Plan Summary');
  lines.push(`- Total steps: ${runPlan.stepCount}`);
  lines.push(`- Global steps: ${runPlan.globalStepCount}`);
  lines.push(`- Item steps: ${runPlan.itemStepCount}`);
  lines.push(`- Upload steps: ${runPlan.uploadStepCount}`);
  lines.push(`- Checkpoint steps: ${runPlan.checkpointStepCount}`);
  lines.push('');

  if (dryRun) {
    lines.push('## Dry Run — Browser Execution Skipped');
    lines.push('No browser was launched. The plan above is ready for inspection and review.');
    lines.push('');
  } else {
    lines.push('## Execution Summary');
    lines.push(`- Steps executed: ${execution.executedStepCount}`);
    lines.push(`- Steps skipped: ${execution.skippedStepCount}`);
    lines.push(`- Human checkpoint reached: ${execution.checkpointReached ? 'yes' : 'no'}`);
    if (execution.error) {
      lines.push(`- **Error:** ${execution.error}`);
    }
    lines.push('');

    if (execution.finalState) {
      const gs = execution.finalState.globalFields || {};
      lines.push('## Global Fields Filled');
      for (const [k, v] of Object.entries(gs)) {
        lines.push(`- \`${k}\`: ${v ?? '(empty)'}`);
      }
      lines.push('');

      lines.push('## Repeated Item Groups Processed');
      const sectionCount = execution.finalState.itemSectionCount ?? 0;
      lines.push(`- Item sections in DOM: ${sectionCount}`);
      for (const [i, item] of (execution.finalState.itemSections || []).entries()) {
        const firstField = Object.entries(item)[0];
        const itemLabel = firstField ? `${firstField[0]}="${firstField[1] || '(empty)'}"` : '(no fields)';
        lines.push(`  - Item ${i + 1}: ${itemLabel}`);
      }
      lines.push('');

      lines.push('## Upload Fields Handled');
      const uploads = (execution.executedSteps || []).filter(
        s => s.type === 'upload_global' || s.type === 'upload_item'
      );
      if (uploads.length > 0) {
        for (const u of uploads) {
          const label = u.type === 'upload_global'
            ? `global: ${u.source}`
            : `track[${u.itemIndex}]: ${u.fieldName}`;
          lines.push(`- ${label} → \`${path.basename(u.resolvedPath || u.value || '')}\``);
        }
      } else {
        lines.push('- (none)');
      }
      lines.push('');
    }
  }

  lines.push('## Human Checkpoint');
  if (execution?.checkpointReached) {
    lines.push('- **Checkpoint reached.** Human review required before any final action.');
  } else {
    lines.push('- Checkpoint not yet reached.');
  }
  lines.push('');

  lines.push('## Blocked Actions');
  const blocked = execution?.blockedActions || [];
  if (blocked.length > 0) {
    for (const action of blocked) {
      lines.push(`- "${action}"`);
    }
  } else {
    lines.push('- (none listed)');
  }
  lines.push('');

  lines.push('## Safety Statement');
  lines.push('> **Final submit, "Upload to stores", legal certification, and distribution');
  lines.push('> actions were NOT clicked by this automation.**');
  lines.push('> A human must review all filled fields, complete any legal certifications,');
  lines.push('> and click final submit manually.');
  lines.push('');

  return lines.join('\n');
}
