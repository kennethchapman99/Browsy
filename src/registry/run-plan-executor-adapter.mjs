// Adapter that bridges the HTTP-API run executor to the run-plan + Playwright
// executor for workflows whose execution_strategy is "run-plan".
//
// The run-plan path handles variable-count repeat groups (e.g. N tracks on an
// album) that a flat recorded-step replay cannot express. It reads the workflow's
// field-map.local.json to find the repeat group config and the start URL, then
// uses buildRunPlan + executeRunPlanWithPlaywright.
//
// Called by run-executor-real.mjs when workflowVersion.replaySettings.strategy === 'run-plan'.

import { pathToFileURL } from 'url';
import { join, resolve, isAbsolute } from 'path';
import { REPO_ROOT, exists } from '../core/paths.mjs';
import { buildRunPlan } from '../core/run-plan.mjs';
import { executeRunPlanWithPlaywright } from '../core/playwright-executor.mjs';
import { loadFieldMap, loadSafetyPolicy, loadWorkflowConfig } from '../core/workflow-runtime.mjs';
import { authProfileFor, assertProfileNotLocked, reclaimOwnProfileLock } from './replay-executor.mjs';
import { updateRun } from './run-registry.mjs';

export async function executeRunPlanRun({
  runId,
  workflowVersion,
  payload = {},
  mode = 'preview',
  options = {},
  runDir,
}) {
  const workflowId = workflowVersion.packageWorkflowId || workflowVersion.workflowId;

  const fieldMap = loadFieldMap(workflowId);
  const safetyPolicy = loadSafetyPolicy(workflowId);
  const workflowConfig = loadWorkflowConfig(workflowId);

  const rgConfig = fieldMap.repeatGroups?.[0];
  if (!rgConfig) {
    throw new Error(`No repeatGroups declared in field-map for workflow "${workflowId}". Add a repeatGroups entry to field-map.local.json.`);
  }

  // Global fields: top-level (non-item) field sources from the field map.
  // Item fields (marked item:true) are handled per-iteration by the repeat group.
  const globalFields = Object.values(fieldMap.fields || {})
    .filter(f => f.source && !f.item)
    .map(f => f.source);

  // Item fields: translate from field-map format (source: "track.fieldName") to
  // the { name, source } objects buildRunPlan expects.
  const itemFields = Object.entries(rgConfig.itemFields || {}).map(([name, def]) => ({
    name,
    source: def.source,
  }));

  const itemName = rgConfig.itemName || rgConfig.id.replace(/s$/, '');

  const repeatGroup = {
    name: rgConfig.id,
    source: `${rgConfig.id}[]`,
    itemName,
    globalFields,
    itemFields,
    repeatAction: rgConfig.createAction || null,
  };

  const runPlan = buildRunPlan(repeatGroup, payload);

  // Pancake drives real runs with mode:'preview' plus a persistent-profile
  // request in options; mode:'live' is the explicit alias. Either one means
  // "drive the real target site with the logged-in profile." The run plan's
  // mandatory human_checkpoint is what stops before final submit — not the mode.
  const wantsLiveSite = mode === 'live'
    || options.usePersistentProfile === true
    || !!options.authProfileId;

  const targetUrl = resolveTargetUrl(workflowConfig, mode, wantsLiveSite);
  const headless = !wantsLiveSite && options.headless !== false;

  // Reuse the same persistent auth profile the recorded-replay path uses, so the
  // DistroKid session is already logged in when we drive the live site.
  let userDataDir = null;
  if (wantsLiveSite) {
    const authProfile = authProfileFor(workflowVersion, options);
    if (authProfile?.userDataDir) {
      await reclaimOwnProfileLock(authProfile);
      assertProfileNotLocked(authProfile);
      userDataDir = authProfile.userDataDir;
    }
  }

  // Base directory for resolving relative upload paths from the payload.
  const manifestBaseDir = options.manifestBaseDir || payload.manifestBaseDir || process.cwd();

  // For a live/headed run, leave the filled browser open at the human checkpoint
  // so a person can review and click final submit (Pancake requests this via
  // options.leaveBrowserOpen). Never leave a headless fixture/preview browser open.
  const leaveBrowserOpen = wantsLiveSite && options.leaveBrowserOpen !== false;

  // End-to-end auto-submit is opt-in only (options.autoSubmit). On the live site
  // we additionally require a human confirmation (confirmBeforeSubmit) before the
  // executor clicks final submit; the confirm signal is a flag file under the run
  // dir, written by POST /api/runs/:runId/confirm-submit. Against the fake fixture
  // we proceed without a human (no real account is touched).
  const autoSubmit = options.autoSubmit === true;
  const confirmBeforeSubmit = autoSubmit && wantsLiveSite && options.confirmBeforeSubmit !== false;
  const confirmFlagPath = runDir ? join(runDir, 'confirm-submit.flag') : null;
  const confirmTimeoutMs = Number(options.confirmTimeoutMs) || undefined;

  // When we're going to park for a human confirm, publish the flag path + state
  // on the run record so POST /api/runs/:runId/confirm-submit can drop the flag
  // file at exactly the path the executor is polling (no path recomputation).
  if (confirmBeforeSubmit && confirmFlagPath) {
    updateRun(runId, { awaitingSubmitConfirm: true, confirmFlagPath });
  }

  const result = await executeRunPlanWithPlaywright({
    runPlan,
    targetUrl,
    fieldMap,
    safetyPolicy,
    headless,
    userDataDir,
    manifestBaseDir,
    downloadsDir: runDir || null,
    leaveBrowserOpen,
    autoSubmit,
    confirmBeforeSubmit,
    confirmFlagPath,
    confirmTimeoutMs,
    isFixture: !wantsLiveSite,
  });

  return {
    ok: result.ok,
    workflow_id: workflowId,
    run_id: runId,
    source_system: 'run_plan_executor',
    mode,
    status: result.ok ? 'replay_passed' : 'replay_failed',
    completed_steps: result.executedSteps || [],
    skipped_steps: result.skippedSteps || [],
    checkpoint_reached: !!result.checkpoint && !result.postSubmitCompleted,
    human_checkpoint: result.postSubmitCompleted ? null : (result.checkpoint || null),
    browser_left_open: result.browserLeftOpen ?? false,
    post_submit_completed: result.postSubmitCompleted ?? false,
    captured_outputs: result.capturedOutputs || {},
    final_state: result.finalState || null,
    error: result.error || null,
    failed_step: result.failed_step || null,
    artifact_paths: [],
    artifacts: [],
    return_contract_version: 'automation-result-v1',
    generated_at: new Date().toISOString(),
  };
}

// Resolve the browser URL to navigate to.
// preview/dry_run mode → local fixture (no DistroKid account needed)
// live mode → real target URL from workflow.json targets.start_url
function resolveTargetUrl(workflowConfig, mode, wantsLiveSite = false) {
  if (mode === 'live' || wantsLiveSite) {
    const url = workflowConfig.targets?.start_url;
    if (!url) throw new Error('workflow.json targets.start_url is required to drive the live site.');
    return url;
  }

  // preview / dry_run: use local fixture so no real account is needed
  const fixtureRelPath = workflowConfig.targets?.fixture_url;
  if (fixtureRelPath) {
    const absPath = isAbsolute(fixtureRelPath)
      ? fixtureRelPath
      : resolve(REPO_ROOT, fixtureRelPath);
    if (!exists(absPath)) {
      throw new Error(`Fixture not found at "${absPath}". Update targets.fixture_url in workflow.json or run in live mode.`);
    }
    return pathToFileURL(absPath).href;
  }

  // Fallback: derive fixture path from repo root + distrokid-wizard default
  const defaultFixture = join(REPO_ROOT, 'fixtures', 'distrokid-wizard', 'index.html');
  if (exists(defaultFixture)) return pathToFileURL(defaultFixture).href;

  throw new Error('No fixture URL configured. Set targets.fixture_url in workflow.json or run in live mode.');
}
