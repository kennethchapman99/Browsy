// Generic automation package runner.
//
// Accepts a self-contained package JSON (new generic format) and runs it
// through the Browsy pipeline: build run plan → execute → write artifacts.
//
// Unlike automation-package-runner.mjs (which requires AUTOMATION_REQUEST.md
// + manifest.json), this runner reads everything from one package file.
//
// Options:
//   packagePath  — absolute path to the package JSON file
//   fixturePath  — absolute path to the HTML fixture or target page
//   headless     — launch browser headless (default true)
//   dryRun       — skip browser execution (default false)
//   trace        — save Playwright trace (default false)
//   artifactDir  — override artifact output directory
//
// Returns { ok, dryRun, package, runPlan, execution, artifacts }

import fs from 'fs';
import path from 'path';
import { buildRunPlanFromPackage, countStepsByType } from './run-plan.mjs';
import { executeRunPlanWithPlaywright } from './playwright-executor.mjs';
import { REPO_ROOT, ensureDir, writeJson, writeText } from './paths.mjs';

export async function runPackage({
  packagePath,
  fixturePath,
  headless = true,
  dryRun = false,
  trace = false,
  artifactDir,
} = {}) {
  if (!fs.existsSync(packagePath)) {
    throw new Error(`Package not found: ${packagePath}`);
  }

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  } catch (e) {
    throw new Error(`Invalid package JSON at ${packagePath}: ${e.message}`);
  }

  const packageBaseDir = path.dirname(packagePath);
  const runPlan = buildRunPlanFromPackage(pkg);
  const stepCounts = countStepsByType(runPlan);

  const runPlanSummary = {
    stepCount: runPlan.steps.length,
    globalStepCount:     (stepCounts.fill_global   || 0) + (stepCounts.upload_global || 0),
    itemStepCount:       (stepCounts.fill_item      || 0) + (stepCounts.upload_item   || 0),
    uploadStepCount:     (stepCounts.upload_global  || 0) + (stepCounts.upload_item   || 0),
    checkpointStepCount: (stepCounts.human_checkpoint || 0),
    warnings: runPlan.warnings,
  };

  // Total item count across all repeat groups
  const itemCount = (pkg.repeatGroups || []).reduce((sum, rg) => sum + (rg.items || []).length, 0);

  const packageSummary = {
    path: packagePath,
    workflowId: pkg.workflowId || '(unknown)',
    targetName: pkg.target?.name || '(unknown)',
    itemCount,
    repeatGroupCount: (pkg.repeatGroups || []).length,
  };

  // Resolve artifact directory
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const resolvedArtifactDir = artifactDir
    || path.join(REPO_ROOT, 'artifacts', 'package-runs', timestamp);
  ensureDir(resolvedArtifactDir);

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
    if (!fixturePath || !fs.existsSync(fixturePath)) {
      throw new Error(`Target fixture not found: ${fixturePath}`);
    }
    executionResult = await executeRunPlanWithPlaywright({
      runPlan,
      fixturePath,
      manifestBaseDir: packageBaseDir,
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

  const artifactData = {
    ok,
    dryRun,
    generatedAt: new Date().toISOString(),
    package: packageSummary,
    runPlan: runPlanSummary,
    execution,
  };

  const jsonPath     = path.join(resolvedArtifactDir, 'automation-run.json');
  const markdownPath = path.join(resolvedArtifactDir, 'automation-run.md');

  writeJson(jsonPath, artifactData);
  writeText(markdownPath, buildPackageMarkdownReport(artifactData, { packagePath, fixturePath }));

  return { ok, dryRun, package: packageSummary, runPlan: runPlanSummary, execution, artifacts: { jsonPath, markdownPath } };
}

function buildPackageMarkdownReport(artifact, { packagePath, fixturePath }) {
  const { package: pkg, runPlan, execution, dryRun } = artifact;
  const lines = [];

  lines.push('# Browsy Automation Run Report');
  lines.push('');
  lines.push(`Generated: ${artifact.generatedAt}`);
  lines.push(`Mode: ${dryRun ? 'dry-run' : 'execute'}`);
  lines.push(`Status: ${artifact.ok ? 'OK' : 'FAILED'}`);
  lines.push('');

  lines.push('## Package');
  lines.push(`- File: \`${packagePath}\``);
  lines.push(`- Workflow: \`${pkg.workflowId}\``);
  lines.push(`- Target: ${pkg.targetName}`);
  lines.push(`- Items: ${pkg.itemCount} across ${pkg.repeatGroupCount} repeat group(s)`);
  if (runPlan.warnings.length > 0) {
    lines.push('- Warnings:');
    for (const w of runPlan.warnings) lines.push(`  - ${w}`);
  }
  lines.push('');

  lines.push('## Target');
  lines.push(`- \`${fixturePath || '(not specified)'}\``);
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
    lines.push('No browser was launched. The plan above is ready for inspection.');
    lines.push('');
  } else {
    lines.push('## Execution Summary');
    lines.push(`- Steps executed: ${execution.executedStepCount}`);
    lines.push(`- Steps skipped: ${execution.skippedStepCount}`);
    lines.push(`- Human checkpoint reached: ${execution.checkpointReached ? 'yes' : 'no'}`);
    if (execution.error) lines.push(`- **Error:** ${execution.error}`);
    lines.push('');

    if (execution.finalState) {
      const { globalFields = {}, itemSections = [], itemSectionCount = 0 } = execution.finalState;

      lines.push('## Global Fields Filled');
      const globalFilled = Object.entries(globalFields);
      if (globalFilled.length > 0) {
        for (const [k, v] of globalFilled) lines.push(`- \`${k}\`: ${v ?? '(empty)'}`);
      } else {
        lines.push('- (none)');
      }
      lines.push('');

      lines.push('## Repeated Item Groups Processed');
      lines.push(`- Item sections in DOM: ${itemSectionCount}`);
      for (const [i, item] of itemSections.entries()) {
        const firstField = Object.entries(item)[0];
        const label = firstField ? `${firstField[0]}="${firstField[1] ?? '(empty)'}"` : '(no fields)';
        lines.push(`  - Item ${i + 1}: ${label}`);
      }
      lines.push('');

      const uploads = (execution.executedSteps || []).filter(
        s => s.type === 'upload_global' || s.type === 'upload_item'
      );
      lines.push('## Upload Fields Handled');
      if (uploads.length > 0) {
        for (const u of uploads) {
          const label = u.type === 'upload_global'
            ? `global: ${u.source}`
            : `item[${u.itemIndex}]: ${u.fieldName}`;
          lines.push(`- ${label} → \`${path.basename(u.resolvedPath || u.value || '')}\``);
        }
      } else {
        lines.push('- (none)');
      }
      lines.push('');

      const defaults = (execution.executedSteps || []).filter(s => s.fromDefault);
      if (defaults.length > 0) {
        lines.push('## Defaults Applied');
        for (const d of defaults) {
          lines.push(`- item[${d.itemIndex}].${d.fieldName} = \`${d.value ?? '(empty)'}\` (from defaults)`);
        }
        lines.push('');
      }
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
    for (const action of blocked) lines.push(`- "${action}"`);
  } else {
    lines.push('- (none listed)');
  }
  lines.push('');

  lines.push('## Safety Statement');
  lines.push('> **Final submit and irreversible actions were NOT clicked by this automation.**');
  lines.push('> A human must review all filled fields and click final submit manually.');
  lines.push('');

  return lines.join('\n');
}
