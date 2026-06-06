import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { chromium } from 'playwright';
import { OUTPUT_DIR, ensureDir, exists, writeJson } from '../core/paths.mjs';
import { availableRuntimeVars, getRuntimeValue, normalizeReleasePayload, resolveTemplate, hasTemplateVars } from '../core/runtime-vars.mjs';

export async function runReplay({ runId, workflowVersion, payload = {}, mode = 'preview', options = {}, runDir }) {
  payload = normalizeReleasePayload(payload);
  const dir = runDir || path.join(OUTPUT_DIR, 'replay-runs', runId);
  const screenshotsDir = path.join(dir, 'screenshots');
  const downloadsDir = path.join(dir, 'downloads');
  ensureDir(dir);
  ensureDir(screenshotsDir);
  ensureDir(downloadsDir);

  const authProfile = authProfileFor(workflowVersion, options);
  const contextOptions = { acceptDownloads: true };
  if (authProfile.storageStatePath && exists(authProfile.storageStatePath) && options.ignoreStorageState !== true) {
    contextOptions.storageState = authProfile.storageStatePath;
  }

  const headless = options.headless === true || process.env.BROWSY_REPLAY_HEADLESS === 'true';
  const slowMo = Number(options.slowMo || process.env.BROWSY_REPLAY_SLOWMO || 0) || 0;
  const leaveOpen = options.leaveBrowserOpen === true || process.env.BROWSY_REPLAY_LEAVE_OPEN === 'true';
  const timeout = Number(options.timeoutMs || process.env.BROWSY_REPLAY_TIMEOUT_MS || 15000) || 15000;
  const settleMs = Number(options.settleMs || process.env.BROWSY_REPLAY_SETTLE_MS || 2500) || 2500;
  const steps = Array.isArray(workflowVersion.recordedSteps) ? workflowVersion.recordedSteps : [];
  const tabs = Array.isArray(workflowVersion.tabs) ? workflowVersion.tabs : [];
  const tabUrlTemplates = Array.isArray(workflowVersion.tabUrlTemplates) ? workflowVersion.tabUrlTemplates : [];
  // A recorded navigate step bakes in the concrete URL from recording time (e.g.
  // a specific releaseId). The per-tab urlTemplate is the parameterized form, so
  // prefer it — re-resolved against THIS run's payload — and only fall back to the
  // recorded url when there is no template (or it cannot be resolved).
  const navigateUrlForStep = (step, tabId) => {
    const template = step.urlTemplate
      || tabUrlTemplates.find(t => t.id === tabId)?.urlTemplate
      || tabs.find(t => t.id === tabId)?.urlTemplate;
    if (typeof template === 'string' && hasTemplateVars(template)) {
      try { return resolveStepUrl(template, payload); } catch { /* fall back to recorded url */ }
    }
    return resolveStepUrl(step.url, payload);
  };
  const preflight = preflightReplayPayload({ steps, payload });

  let browser = null;
  let context = null;
  const pages = new Map();
  const lastUrls = new Map();
  const completedSteps = [];
  const failedSteps = [];
  const skippedSteps = [];
  const capturedOutputs = {};
  const screenshots = [];
  const downloads = [];
  const filledFields = [];
  const uploadedFiles = [];
  const manualCheckpoints = [];
  const logs = [{
    type: 'replay_started',
    runId,
    workflowId: workflowVersion.workflowId || workflowVersion.packageWorkflowId,
    mode,
    runDir: dir,
    variableResolution: {
      availableVariables: availableRuntimeVars(payload),
      tabs: tabs.map(tab => clean({
        id: tab.id,
        urlTemplate: tab.urlTemplate || tab.url || null,
        resolvedUrl: resolveMaybe(tab.urlTemplate || tab.url, payload),
      })),
    },
  }];

  try {
    if (!preflight.ok) {
      logs.push({ type: 'replay_result', status: 'preflight_failed', ok: false, runDir: dir, failedStepCount: preflight.errors.length });
      const result = clean({
        ok: false,
        workflow_id: workflowVersion.workflowId || workflowVersion.packageWorkflowId,
        run_id: runId,
        source_system: 'playwright_replay',
        entity_type: workflowVersion.appId,
        entity_id: runId,
        mode,
        status: 'preflight_failed',
        completedSteps,
        failedSteps: preflight.errors.map(error => ({ id: 'preflight', type: 'preflight', status: 'failed', error })),
        skippedSteps,
        filled_fields: filledFields,
        uploaded_files: uploadedFiles,
        captured_outputs: withExpectedOutputs(capturedOutputs, workflowVersion.expectedOutputs || []),
        manual_checkpoints: manualCheckpoints,
        downloaded_files: [],
        screenshots: [],
        artifacts: [],
        artifact_paths: [],
        logs: [...logs, { type: 'preflight_failed', errors: preflight.errors }],
        authProfile,
        next_required_action: 'fix_payload',
        return_contract_version: 'automation-result-v1',
        generated_at: new Date().toISOString(),
      });
      console.log('[browsy:replay] result', { runId, status: result.status, ok: result.ok, runDir: dir, failedStepCount: result.failedSteps.length });
      writeJson(path.join(dir, 'playwright-result.json'), result);
      return result;
    }

    if (options.usePersistentProfile === true || process.env.BROWSY_REPLAY_PERSISTENT_PROFILE === 'true') {
      ensureDir(authProfile.userDataDir);
      if (options.reclaimProfile !== false && process.env.BROWSY_REPLAY_NO_RECLAIM !== 'true') {
        const reclaim = await reclaimOwnProfileLock(authProfile);
        if (reclaim.reclaimed) {
          logs.push({ type: 'profile_lock_reclaimed', ownerPid: reclaim.ownerPid, userDataDir: authProfile.userDataDir });
        } else if (reclaim.ownerPid) {
          logs.push({ type: 'profile_lock_reclaim_skipped', reason: reclaim.reason, ownerPid: reclaim.ownerPid });
        }
      }
      assertProfileNotLocked(authProfile);
      context = await chromium.launchPersistentContext(authProfile.userDataDir, { headless, slowMo, acceptDownloads: true });
    } else {
      browser = await chromium.launch({ headless, slowMo });
      context = await browser.newContext(contextOptions);
    }

    context.on('download', async d => {
      try {
        const name = d.suggestedFilename() || `download-${Date.now()}`;
        const target = path.join(downloadsDir, safeName(name));
        await d.saveAs(target);
        downloads.push({ name, path: target, type: 'download' });
      } catch (err) {
        logs.push({ type: 'download_failed', error: err.message });
      }
    });

    for (const step of steps) {
      const type = step.type || step.action;
      writeJson(path.join(dir, 'progress.json'), clean({
        status: 'running',
        runId,
        currentStep: { id: step.id, type, order: step.order, tabId: step.tabId || null, selector: step.selector || null },
        completedStepCount: completedSteps.length,
        failedStepCount: failedSteps.length,
        updated_at: new Date().toISOString(),
      }));
      try {
        if (type === 'approve' || step.requiresApproval) {
          manualCheckpoints.push({ type: 'materialized_checkpoint', checkpointId: step.checkpointId || step.id, label: step.label || step.id, beforeAction: step.beforeAction || null, reason: step.reason || 'approval required' });
          skippedSteps.push({ id: step.id, type, status: 'checkpoint' });
          continue;
        }

        if (type === 'navigate') {
          const tabId = step.tabId || tabs[0]?.id || 'tab1';
          const page = await getPage(context, pages, tabId);
          await page.goto(navigateUrlForStep(step, tabId), { waitUntil: step.waitUntil || 'domcontentloaded', timeout });
          await settlePage(page, { timeout, settleMs, targetHost: hostFromStep(step) });
          lastUrls.set(tabId, page.url());
          completedSteps.push({ id: step.id, type, status: 'completed', tabId: step.tabId, url: page.url() });
          pushUnique(screenshots, await shot(page, screenshotsDir, `${step.order || completedSteps.length}-${step.id}`));
          continue;
        }

        if (type === 'fill' || type === 'select') {
          const safetySkip = safetySkipForStep(step, type);
          if (safetySkip) {
            skippedSteps.push({ id: step.id, type, status: 'safety_skipped', reason: safetySkip.reason, safetyCategory: safetySkip.category, selector: step.selector || null });
            manualCheckpoints.push({ type: 'manual_field', checkpointId: step.id, label: step.label || step.binding || step.id, beforeAction: type, reason: safetySkip.reason });
            continue;
          }
          const page = await getPage(context, pages, step.tabId || tabs[0]?.id || 'tab1');
          await settlePage(page, { timeout, settleMs });
          const value = valueForStep(step, payload);
          const loc = await locateField(page, step, payload, timeout);
          if (type === 'select') await selectOptionSmart(loc, value, { timeout });
          else await applyInputValue(loc, value, { timeout });
          filledFields.push({ field: step.binding || step.id, selector: step.selector || null, status: 'filled' });
          completedSteps.push({ id: step.id, type, status: 'completed', tabId: step.tabId });
          continue;
        }

        if (type === 'uploadFile') {
          const page = await getPage(context, pages, step.tabId || tabs[0]?.id || 'tab1');
          await settlePage(page, { timeout, settleMs });
          if (isDistroKidAudioUploadStep(step)) {
            const uploaded = await uploadDistroKidTrackAudioFiles(page, payload, { timeout });
            if (uploaded.length) {
              uploadedFiles.push(...uploaded);
              completedSteps.push({ id: step.id, type, status: 'completed', tabId: step.tabId, uploadedCount: uploaded.length });
              continue;
            }
          }
          const filePath = fileFor(step.file, payload, step.binding);
          if (!filePath) throw new Error(`missing file for ${step.binding || step.id}`);
          const loc = await locateField(page, step, payload, timeout);
          await loc.setInputFiles(filePath, { timeout });
          uploadedFiles.push({ role: step.binding || step.id, selector: step.selector || null, path: filePath, status: 'uploaded' });
          completedSteps.push({ id: step.id, type, status: 'completed', tabId: step.tabId });
          continue;
        }

        if (type === 'click') {
          const safetySkip = safetySkipForStep(step, type);
          if (safetySkip) {
            skippedSteps.push({ id: step.id, type, status: 'safety_skipped', reason: safetySkip.reason, safetyCategory: safetySkip.category, selector: step.selector || null });
            manualCheckpoints.push({ type: 'manual_action', checkpointId: step.id, label: step.label || step.binding || step.id, beforeAction: type, reason: safetySkip.reason });
            continue;
          }
          if (isRecordedSelectOrFileClick(step)) {
            skippedSteps.push({ id: step.id, type, status: 'redundant_recorded_control_click_skipped', selector: step.selector || null });
            continue;
          }
          const tabId = step.tabId || tabs[0]?.id || 'tab1';
          let page = await getPage(context, pages, tabId);
          await settlePage(page, { timeout, settleMs });
          // Modal action buttons (swal2 "Do it"/"OK"/"Save"/"Confirm") have brittle,
          // recording-specific selectors and don't all appear on every run. Locate
          // them by visible label and click if present; if the button isn't on
          // screen, skip rather than hang in locate-recovery — otherwise a missing
          // intermediate dialog blocks the real Save and stalls the whole run.
          const modalLabel = modalActionLabel(step);
          if (modalLabel) {
            const clicked = await clickModalActionButton(page, modalLabel, { timeout, settleMs });
            if (clicked) {
              await settlePage(page, { timeout, settleMs });
              lastUrls.set(tabId, page.url());
              completedSteps.push({ id: step.id, type, status: 'completed', tabId: step.tabId, label: step.label || modalLabel, modalAction: true });
              pushUnique(screenshots, await shot(page, screenshotsDir, `${step.order || completedSteps.length}-${step.id}`));
            } else {
              skippedSteps.push({ id: step.id, type, status: 'modal_action_absent_skipped', selector: step.selector || null, label: step.label || modalLabel });
            }
            continue;
          }
          const located = await locateWithRecovery({ context, pages, lastUrls, tabId, step, timeout, settleArgs: { timeout, settleMs }, screenshotsDir, screenshots });
          page = located.page;
          if (await isRedundantControlClick(located.loc)) {
            skippedSteps.push({ id: step.id, type, status: 'redundant_control_click_skipped', selector: step.selector || null });
            continue;
          }
          await located.loc.click({ timeout });
          await settlePage(page, { timeout, settleMs });
          lastUrls.set(tabId, page.url());
          completedSteps.push({ id: step.id, type, status: 'completed', tabId: step.tabId, label: step.label || null, recovered: located.recovered || undefined });
          pushUnique(screenshots, await shot(page, screenshotsDir, `${step.order || completedSteps.length}-${step.id}`));
          continue;
        }

        if (type === 'extractText' || type === 'extractAttribute') {
          const outputId = step.output || step.binding || step.id;
          const page = await getPage(context, pages, step.tabId || bestOutputTab(tabs));
          await settlePage(page, { timeout, settleMs });
          let value = null;
          if (step.selector) {
            const loc = await locate(page, step, timeout);
            value = type === 'extractAttribute'
              ? await loc.getAttribute(step.attribute || 'href', { timeout })
              : await loc.innerText({ timeout });
          } else {
            value = await infer(page, outputId, workflowVersion.expectedOutputs || []);
          }
          capturedOutputs[outputId] = { status: value ? 'captured' : 'empty', value, selector: step.selector || null, required: step.required !== false };
          completedSteps.push({ id: step.id, type, status: value ? 'completed' : 'completed_empty', tabId: step.tabId, output: outputId });
          pushUnique(screenshots, await shot(page, screenshotsDir, `${step.order || completedSteps.length}-${step.id}`));
          continue;
        }

        skippedSteps.push({ id: step.id, type, status: 'unsupported_step_type' });
      } catch (err) {
        const page = pages.get(step.tabId || tabs[0]?.id || 'tab1');
        const diagnostic = page && !isClosedError(err) ? await pageDiagnostic(page) : {};
        if (page && !isClosedError(err)) pushUnique(screenshots, await shot(page, screenshotsDir, `failed-${step.id || type}`));
        failedSteps.push({
          id: step.id,
          type,
          status: 'failed',
          error: err.message,
          selector: step.selector || null,
          tabId: step.tabId || null,
          candidateLabels: err.candidateLabels || candidateLabels(step),
          selectorAttempts: err.attempts || [],
          ...diagnostic,
        });
        if (options.stopOnStepFailure !== false) break;
      }
    }

    for (const [tabId, page] of pages.entries()) pushUnique(screenshots, await shot(page, screenshotsDir, `final-${tabId}`));

    const uniqueScreenshots = uniqueByPath(screenshots.filter(Boolean));
    const uniqueDownloads = uniqueByPath(downloads.filter(Boolean));
    const finalStatus = failedSteps.length ? 'replay_failed' : 'replay_passed';
    logs.push({
      type: 'replay_result',
      status: finalStatus,
      ok: failedSteps.length === 0,
      runDir: dir,
      completedStepCount: completedSteps.length,
      failedStepCount: failedSteps.length,
      artifactCount: uniqueScreenshots.length + uniqueDownloads.length,
    });
    const result = clean({
      ok: failedSteps.length === 0,
      workflow_id: workflowVersion.workflowId || workflowVersion.packageWorkflowId,
      run_id: runId,
      source_system: 'playwright_replay',
      entity_type: workflowVersion.appId,
      entity_id: runId,
      mode,
      status: finalStatus,
      completedSteps,
      failedSteps,
      skippedSteps,
      filled_fields: filledFields,
      uploaded_files: uploadedFiles,
      captured_outputs: withExpectedOutputs(capturedOutputs, workflowVersion.expectedOutputs || []),
      manual_checkpoints: manualCheckpoints,
      downloaded_files: uniqueDownloads,
      screenshots: uniqueScreenshots,
      artifacts: [...uniqueScreenshots.map(s => ({ ...s, type: 'screenshot' })), ...uniqueDownloads],
      artifact_paths: [...uniqueScreenshots.map(s => s.path), ...uniqueDownloads.map(d => d.path)],
      logs,
      authProfile,
      next_required_action: null,
      return_contract_version: 'automation-result-v1',
      generated_at: new Date().toISOString(),
    });
    console.log('[browsy:replay] result', {
      runId,
      workflowId: result.workflow_id,
      status: result.status,
      ok: result.ok,
      runDir: dir,
      completedStepCount: completedSteps.length,
      failedStepCount: failedSteps.length,
      artifactCount: result.artifacts.length,
    });
    writeJson(path.join(dir, 'playwright-result.json'), result);
    writeJson(path.join(dir, 'progress.json'), clean({ status: finalStatus, runId, completedStepCount: completedSteps.length, failedStepCount: failedSteps.length, updated_at: new Date().toISOString() }));
    return result;
  } finally {
    if (!leaveOpen) {
      try { await context?.close(); } catch {}
      try { await browser?.close(); } catch {}
    }
  }
}

function resolveMaybe(template, vars) {
  try {
    return template && hasTemplateVars(template) ? resolveTemplate(template, vars) : template;
  } catch {
    return null;
  }
}

function preflightReplayPayload({ steps = [], payload = {} } = {}) {
  const errors = [];
  for (const step of steps) {
    const type = step.type || step.action;
    if (type !== 'uploadFile') continue;
    const binding = step.binding || null;
    if (isDistroKidAudioUploadStep(step)) {
      for (const filePath of distroKidAudioFilesFromPayload(payload)) {
        if (typeof filePath === 'string' && !exists(filePath)) {
          errors.push(`Required track audio file does not exist: ${filePath}`);
        }
      }
      continue;
    }
    const filePath = fileFor(step.file, payload, binding);
    if (!filePath) {
      errors.push(`Missing required file path for ${binding || step.id}. Add ${binding || step.file || 'the upload file'} to the album payload before replay.`);
      continue;
    }
    if (typeof filePath === 'string' && !exists(filePath)) {
      errors.push(`Required file for ${binding || step.id} does not exist: ${filePath}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export function authProfileFor(workflowVersion, options = {}) {
  const auth = Array.isArray(workflowVersion.auth) ? workflowVersion.auth : [];
  const first = auth.find(a => a.authProfileId) || auth[0] || null;
  const id = safeSegment(options.authProfileId || first?.authProfileId || first?.siteId || workflowVersion.appId || 'default');
  const appId = safeSegment(workflowVersion.appId || options.appId || '');
  const candidates = [
    appId ? path.join(OUTPUT_DIR, 'auth-profiles', appId, id) : null,
    path.join(OUTPUT_DIR, 'auth-profiles', id),
  ].filter(Boolean);
  const dir = candidates.find(candidate => exists(path.join(candidate, 'user-data')) || exists(path.join(candidate, 'storageState.json')))
    || candidates[0];
  return {
    authProfileId: id,
    appId: workflowVersion.appId || options.appId || null,
    authProfileDir: dir,
    userDataDir: path.join(dir, 'user-data'),
    storageStatePath: path.join(dir, 'storageState.json'),
  };
}

const STALE_LOCK_AGE_MS = 5 * 60 * 1000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Returns the command line of a pid, or '' if it can't be read. Used to confirm a
// lock owner is our own browser on THIS profile before we ever terminate it.
function processCommandLine(pid) {
  if (!pid) return '';
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

// True only when `pid` is a live Chromium/Chrome bound to this exact persistent
// profile dir — i.e. a browser Browsy itself launched (a leftover leave-open
// review window or a crashed prior run). A user's own Chrome on a different
// profile will never match, so it is never reclaimed.
function isOwnProfileBrowser(pid, userDataDir) {
  if (!pid || !userDataDir) return false;
  const cmd = processCommandLine(pid);
  if (!cmd) return false;
  return /chrom(e|ium)/i.test(cmd) && cmd.includes(userDataDir);
}

// leaveBrowserOpen runs intentionally leave a browser open for human review, which
// keeps the persistent profile locked. The next run must take that profile back,
// so reclaim a lock held by our own prior browser on the same profile (terminate
// it, then clear the lock). Foreign owners are left untouched for assertProfileNotLocked.
export async function reclaimOwnProfileLock(authProfile, { pollMs = 150, maxWaitMs = 6000 } = {}) {
  const lock = detectProfileLock(authProfile.userDataDir);
  if (!lock.locked) return { reclaimed: false, reason: 'not_locked' };
  const ownerPid = lock.owner?.pid || null;
  if (!ownerPid || !isProcessAlive(ownerPid)) return { reclaimed: false, reason: 'no_live_owner' };
  if (!isOwnProfileBrowser(ownerPid, authProfile.userDataDir)) {
    return { reclaimed: false, reason: 'foreign_owner', ownerPid };
  }
  try { process.kill(ownerPid, 'SIGTERM'); } catch {}
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline && isProcessAlive(ownerPid)) await sleep(pollMs);
  if (isProcessAlive(ownerPid)) {
    try { process.kill(ownerPid, 'SIGKILL'); } catch {}
    const hardDeadline = Date.now() + 2000;
    while (Date.now() < hardDeadline && isProcessAlive(ownerPid)) await sleep(pollMs);
  }
  for (const file of listProfileLockFiles(authProfile.userDataDir)) {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
  const after = detectProfileLock(authProfile.userDataDir);
  return { reclaimed: !after.locked, ownerPid, reason: after.locked ? 'still_locked' : 'reclaimed', after };
}

export function assertProfileNotLocked(authProfile) {
  const recovery = recoverStaleProfileLock(authProfile);
  const lock = recovery.lock || detectProfileLock(authProfile.userDataDir);
  if (!lock.locked) return;
  const err = new Error(`Auth profile "${authProfile.authProfileId}" is locked by another browser process. Close the existing browser profile and retry.`);
  err.code = 'auth_profile_locked';
  err.profileLock = { ...lock, userDataDir: authProfile.userDataDir, authProfileId: authProfile.authProfileId };
  throw err;
}

function recoverStaleProfileLock(authProfile) {
  const lock = detectProfileLock(authProfile.userDataDir);
  if (!lock.locked || !lock.stale) return { ok: !lock.locked, cleared: false, lock, recoveryAction: lock.locked ? 'protect_active_or_recent_lock' : 'none' };
  const removed = [];
  const errors = [];
  for (const file of lock.files) {
    try {
      fs.rmSync(file, { force: true });
      removed.push(file);
    } catch (err) {
      errors.push({ file, error: err.message });
    }
  }
  const after = detectProfileLock(authProfile.userDataDir);
  return { ok: !after.locked, cleared: removed.length > 0, lock: after, removed, errors, recoveryAction: 'auto_clear_stale_lock' };
}

export function detectProfileLock(userDataDir) {
  const lockFiles = listProfileLockFiles(userDataDir).map(inspectLockFile).filter(Boolean);
  const owner = lockFiles.map(detail => detail.owner).find(Boolean) || null;
  const ageMs = lockFiles.length ? Math.max(...lockFiles.map(detail => detail.ageMs || 0)) : null;
  const staleByOwner = owner?.pid ? !isProcessAlive(owner.pid) : false;
  const staleByAge = !owner?.pid && ageMs !== null && ageMs > STALE_LOCK_AGE_MS;
  const stale = lockFiles.length > 0 && (staleByOwner || staleByAge);
  return {
    locked: lockFiles.length > 0,
    files: lockFiles.map(detail => detail.path),
    details: lockFiles,
    owner,
    ageMs,
    stale,
    recoveryAction: stale ? 'auto_clear_stale_lock' : (lockFiles.length ? 'protect_active_or_recent_lock' : 'none'),
  };
}

function listProfileLockFiles(userDataDir) {
  if (!userDataDir) return [];
  const staticNames = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
  const files = staticNames.map(name => path.join(userDataDir, name));
  try {
    for (const name of fs.readdirSync(userDataDir)) {
      if (/^\.(?:com\.google\.Chrome|org\.chromium\.Chromium)/.test(name)) files.push(path.join(userDataDir, name));
    }
  } catch {}
  return files;
}

function inspectLockFile(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    const target = stat.isSymbolicLink() ? safeReadLink(filePath) : safeReadFile(filePath);
    return { path: filePath, name: path.basename(filePath), isSymlink: stat.isSymbolicLink(), target, owner: parseLockOwner(target), ageMs: Math.max(0, Date.now() - stat.mtimeMs), mtime: stat.mtime.toISOString() };
  } catch {
    return null;
  }
}

function safeReadLink(filePath) {
  try { return fs.readlinkSync(filePath); } catch { return ''; }
}

function safeReadFile(filePath) {
  try { return fs.readFileSync(filePath, 'utf8').slice(0, 500); } catch { return ''; }
}

function parseLockOwner(value = '') {
  const pidMatch = String(value || '').match(/(?:^|[^0-9])([1-9][0-9]{1,8})(?:[^0-9]|$)/);
  return pidMatch ? { pid: Number(pidMatch[1]), raw: String(value || '') } : null;
}

function isProcessAlive(pid) {
  if (!pid || pid === process.pid) return Boolean(pid);
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

async function getPage(context, pages, tabId) {
  const id = tabId || 'tab1';
  if (pages.has(id)) return pages.get(id);
  const page = await context.newPage();
  pages.set(id, page);
  return page;
}

async function settlePage(page, { timeout, settleMs, targetHost } = {}) {
  await page.waitForLoadState('domcontentloaded', { timeout: Math.min(timeout || 15000, 10000) }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: Math.min(timeout || 15000, 10000) }).catch(() => {});
  if (targetHost) {
    await page.waitForFunction(host => location.hostname === host || location.hostname.endsWith('.' + host), targetHost, { timeout: Math.min(timeout || 15000, 12000) }).catch(() => {});
  }
  await page.waitForTimeout(Math.min(settleMs || 1500, 5000)).catch(() => {});
}

// Locate a target element. For clicks (preferLabels) we try semantic locators
// (role/aria/text) before brittle recorded CSS, since nav links and buttons
// move around in dynamic apps. For data-targeting steps (fill/select/upload/
// extract) the recorded selector is authoritative and tried first — label text
// like "output" or "title" matches the wrong element otherwise.
async function locate(page, step, timeout, attempts = [], { preferLabels = false } = {}) {
  const selectors = [step.selector, ...(Array.isArray(step.fallbackSelectors) ? step.fallbackSelectors : [])].filter(Boolean);
  const labelTries = [];
  for (const label of candidateLabels(step)) {
    labelTries.push({ kind: 'role-link', label });
    labelTries.push({ kind: 'role-button', label });
    labelTries.push({ kind: 'aria', label });
    labelTries.push({ kind: 'text-exact', label });
    labelTries.push({ kind: 'text-contains', label });
  }
  const cssTries = selectors.map(selector => ({ kind: 'css', selector }));
  const tries = preferLabels ? [...labelTries, ...cssTries] : [...cssTries, ...labelTries];

  let last = null;
  for (const trial of tries) {
    try {
      const loc = locatorFor(page, trial).first();
      await loc.waitFor({ state: 'visible', timeout: Math.min(timeout || 15000, 8000) });
      attempts.push({ ...trial, ok: true });
      return loc;
    } catch (err) {
      attempts.push({ ...trial, ok: false });
      last = err;
    }
  }
  const error = new Error(`no usable selector for ${step.id || 'step'}: ${last?.message || 'missing selector'}`);
  error.attempts = attempts;
  error.candidateLabels = candidateLabels(step);
  throw error;
}

async function locateField(page, step, payload, timeout) {
  if (isDistroKidTrackTitleStep(step)) {
    const loc = await locateDistroKidTrackTitle(page, distroKidTrackIndex(step), timeout);
    if (loc) return loc;
  }
  if (isDistroKidAiGateStep(step)) {
    const loc = await locateDistroKidAiGate(page, valueForStep(step, payload), timeout);
    if (loc) return loc;
  }
  if (isDistroKidAiRecordingScopeStep(step)) {
    const loc = await locateDistroKidAiRecordingScope(page, valueForStep(step, payload), timeout);
    if (loc) return loc;
  }
  if (isDistroKidCreditRoleStep(step)) {
    const loc = await locateDistroKidCreditRole(page, step, timeout);
    if (loc) return loc;
  }
  if (isDistroKidCreditNameStep(step)) {
    const loc = await locateDistroKidCreditName(page, step, timeout);
    if (loc) return loc;
  }
  return locate(page, step, timeout);
}

// Attempt the step on the current page; on a closed page/context or an
// unresolved target, recover the tab (reopen last known URL) and/or search a
// visible in-page search box for the target label, then retry once.
async function locateWithRecovery({ context, pages, lastUrls, tabId, step, timeout, settleArgs, screenshotsDir, screenshots }) {
  const attempts = [];
  let page = pages.get(tabId);

  try {
    return { page, loc: await locate(page, step, timeout, attempts, { preferLabels: true }), attempts };
  } catch (firstErr) {
    pushUnique(screenshots, await shot(page, screenshotsDir, `failed-${step.id}-pre-recovery`));

    if (!isClosedError(firstErr) && pageIsUsable(page)) {
      const viaSearch = await trySearchAndLocate(page, step, timeout, attempts, settleArgs);
      if (viaSearch) return { page, loc: viaSearch, attempts, recovered: 'search' };
    }

    const lastUrl = lastUrls.get(tabId);
    if (lastUrl) {
      page = await recoverPage(context, pages, tabId, lastUrl, settleArgs);
      pushUnique(screenshots, await shot(page, screenshotsDir, `recovered-${step.id}`));
      try {
        return { page, loc: await locate(page, step, timeout, attempts, { preferLabels: true }), attempts, recovered: 'reopen' };
      } catch {
        const viaSearch = await trySearchAndLocate(page, step, timeout, attempts, settleArgs);
        if (viaSearch) return { page, loc: viaSearch, attempts, recovered: 'reopen+search' };
      }
    }

    const error = new Error(firstErr.message);
    error.attempts = attempts;
    error.candidateLabels = candidateLabels(step);
    throw error;
  }
}

async function recoverPage(context, pages, tabId, url, settleArgs = {}) {
  const old = pages.get(tabId);
  try { if (old && !old.isClosed()) await old.close(); } catch {}
  const page = await context.newPage();
  pages.set(tabId, page);
  try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: settleArgs.timeout || 15000 }); } catch {}
  await settlePage(page, settleArgs);
  return page;
}

// Generic dynamic-list recovery: fill a visible in-page search box with the
// target label and retry semantic locators. Not specific to any app.
async function trySearchAndLocate(page, step, timeout, attempts, settleArgs = {}) {
  const labels = candidateLabels(step);
  if (!labels.length || !pageIsUsable(page)) return null;
  const query = labels[0];
  const searchSelectors = [
    'input[type="search"]',
    'input[placeholder*="Search" i]',
    'input[aria-label*="Search" i]',
    '[role="searchbox"]',
    'input.slds-input',
  ];
  for (const selector of searchSelectors) {
    try {
      const box = page.locator(selector).first();
      await box.waitFor({ state: 'visible', timeout: Math.min(timeout || 15000, 3000) });
      await box.fill(query);
      await box.press('Enter');
      attempts.push({ kind: 'search-box', selector, query, ok: true });
      await settlePage(page, settleArgs);
      try {
        return await locate(page, step, timeout, attempts, { preferLabels: true });
      } catch {}
    } catch {
      attempts.push({ kind: 'search-box', selector, ok: false });
    }
  }
  return null;
}

function pageIsUsable(page) {
  try { return !!page && !page.isClosed(); } catch { return false; }
}

function safetySkipForStep(step = {}, type = '') {
  const allText = [
    step.id,
    step.binding,
    step.label,
    step.selector,
    ...(Array.isArray(step.fallbackSelectors) ? step.fallbackSelectors : []),
  ].filter(Boolean).join(' ').toLowerCase();
  const actionText = [step.label, step.text, step.name].filter(Boolean).join(' ').toLowerCase();
  if (step.safetyCategory === 'manual-only') return { category: 'manual-only', reason: 'recorded step is marked manual-only' };
  if (/\bareyousure/.test(allText) || /i\\?\s*agree|i agree|certif|authorized to sell|distribution agreement|terms and conditions|terms of/.test(allText)) {
    return { category: 'legal certification', reason: 'legal/certification checkbox must be completed by a human' };
  }
  if (type === 'click' && /\b(submit|finalize|release|pay|purchase|checkout|confirm order|publish|upload to stores|send to stores|save and submit|continue and submit|continue & submit)\b/.test(actionText)) {
    return { category: 'dangerous action', reason: 'final or externally visible action must remain human-gated' };
  }
  return null;
}

async function isRedundantControlClick(locator) {
  return locator.evaluate(el => {
    const tag = String(el?.tagName || '').toLowerCase();
    const type = String(el?.getAttribute?.('type') || '').toLowerCase();
    return tag === 'select' || (tag === 'input' && type === 'file');
  }).catch(() => false);
}

function isRecordedSelectOrFileClick(step = {}) {
  // Skip recorded clicks that only open native OS UI (a <select> dropdown, a file
  // picker) or local helper buttons — those are handled by the corresponding
  // fill/select/upload steps, and replaying the raw click hangs the browser.
  // Modal confirm/save buttons (swal2 "Confirm"/"OK"/"Save") are intentionally
  // NOT skipped: they commit a dialog (e.g. the AI-credit modal) and must be
  // clicked, or the dialog stays open and the run stalls. They are mid-flow and
  // distinct from final submit, which stays gated by the legal-certification
  // safety skips and human approval checkpoints.
  const text = [step.id, step.label, step.selector, ...(Array.isArray(step.fallbackSelectors) ? step.fallbackSelectors : [])].filter(Boolean).join(' ');
  return /#howManySongsOnThisAlbum|#genrePrimary|select\[name=|#artwork|#js-track-upload-\d+|input\[name="file"\]|input\[name="artwork"\]|input\[name="release_date"\]|#albumTitleInput|#title_|songwriter_real_name_|ai_gate_|aiRecordingScope|#track-1-(?:performer|producer)-1-name|input\[aria-label="Select\\?\s+a\\?\s+role"\]|prepareOpenUploadFolder|Prepare\s*&\s*open upload folder|Copy\\?\s+path/i.test(text);
}

// Returns the visible button text for a recorded modal action click, or null if
// the step is not a modal action. The recorded selectors for these swal2 dialogs
// are unreliable, but the recorded `label` holds the real button text.
function modalActionLabel(step = {}) {
  const sel = String(step.selector || '');
  const label = String(step.label || '').trim();
  const looksModal = /wal2|swal2/i.test(sel) || /aria-label="(confirm|ok|okay|save|continue|yes)"/i.test(sel);
  const actionWord = /^(do it|ok|okay|save|confirm|continue|yes|got it|done)$/i.test(label);
  if (!looksModal && !actionWord) return null;
  if (label && label.length <= 24) return label;
  const aria = sel.match(/aria-label="([^"]+)"/i);
  return aria ? aria[1] : null;
}

// Clicks a modal action button found by visible label, with a short bounded wait.
// Returns true if clicked, false if the button is not present/visible — never
// throws, so an absent dialog is skipped instead of stalling the run.
async function clickModalActionButton(page, label, { timeout, settleMs } = {}) {
  const name = new RegExp(`^\\s*${escapeRegex(label)}\\s*$`, 'i');
  const shortTimeout = Math.min(Number(timeout) || 4000, 3500);
  const candidates = [
    page.getByRole('button', { name }),
    page.locator('.swal2-confirm, .swal2-actions button').filter({ hasText: name }),
    page.locator('button, [role="button"]').filter({ hasText: name }),
  ];
  for (const loc of candidates) {
    try {
      const first = loc.first();
      await first.waitFor({ state: 'visible', timeout: shortTimeout });
      await first.click({ timeout: shortTimeout });
      return true;
    } catch { /* try next candidate */ }
  }
  return false;
}

function isClosedError(err) {
  return /has been closed|target closed|target page, context or browser/i.test(err?.message || '');
}

function locatorFor(page, trial) {
  if (trial.kind === 'role-link') return page.getByRole('link', { name: new RegExp(escapeRegex(trial.label), 'i') });
  if (trial.kind === 'role-button') return page.getByRole('button', { name: new RegExp(escapeRegex(trial.label), 'i') });
  if (trial.kind === 'aria') return page.locator(`[aria-label*="${cssEscape(trial.label)}" i]`);
  if (trial.kind === 'text-exact') return page.getByText(new RegExp(`^\\s*${escapeRegex(trial.label)}\\s*$`, 'i'));
  if (trial.kind === 'text-contains') return page.getByText(new RegExp(escapeRegex(trial.label), 'i'));
  return page.locator(trial.selector);
}

function candidateLabels(step = {}) {
  const values = [];
  for (const value of [step.label, step.name, step.ariaLabel, step.text, step.id, step.selector]) {
    if (!value) continue;
    const cleaned = String(value)
      .replace(/^click[_-]?/i, '')
      .replace(/aria-label\s*=\s*["']?([^"'\]]+).*/i, '$1')
      .replace(/\[[^\]]+\]/g, ' ')
      .replace(/[_-]+/g, ' ')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[^a-zA-Z0-9 ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned || cleaned.length > 80) continue;
    values.push(cleaned);
    const first = cleaned.split(' ')[0];
    if (first && first.length >= 3 && first.toLowerCase() !== cleaned.toLowerCase()) values.push(first);
  }
  return [...new Set(values)];
}

function valueForStep(step = {}, payload = {}) {
  const trackIndex = isDistroKidTrackTitleStep(step) ? distroKidTrackIndex(step) : null;
  if (trackIndex) {
    const title = distroKidTrackValue(payload, trackIndex, ['title', 'trackTitle', 'track_title', 'name']);
    if (title !== undefined && title !== null && title !== '') return title;
  }
  if (isDistroKidAiGateStep(step)) {
    const disclosure = distroKidTrackValue(payload, 1, ['aiDisclosure', 'ai_disclosure']) || payload?.canonical?.ai_disclosure || payload?.distrokid_payload?.ai_disclosure;
    if (disclosure?.all_audio_performed_by_ai || disclosure?.allAudioPerformedByAi) return '1';
    if (disclosure?.part_audio_performed_by_ai_and_humans || disclosure?.partAudioPerformedByAiAndHumans) return '2';
    return '0';
  }
  if (isDistroKidAiRecordingScopeStep(step)) return 'full';
  if (isDistroKidCreditRoleStep(step)) return distroKidCreditValue(payload, step, 'role');
  if (isDistroKidCreditNameStep(step)) return distroKidCreditValue(payload, step, 'name');
  return valueFor(step.value, payload, step.binding);
}

function valueFor(value, payload = {}, binding = null) {
  if (typeof value !== 'string') return value;
  const m = value.match(/^\{\{inputs\.([^}]+)\}\}$/);
  if (m) return getRuntimeValue(payload, `inputs.${m[1]}`) ?? getRuntimeValue(payload, m[1]);
  const payloadToken = value.match(/^\{\{payload\.([^}]+)\}\}$/);
  if (payloadToken) return getRuntimeValue(payload, payloadToken[1]);
  if (hasTemplateVars(value)) return resolveTemplate(value.replace(/\{\{payload\./g, '{{'), payload);
  if (binding) {
    const bound = getRuntimeValue(payload, binding);
    if (bound !== undefined) return bound;
  }
  return value;
}

async function selectOptionSmart(locator, value, { timeout } = {}) {
  const raw = value === undefined || value === null ? '' : String(value);
  const candidates = [...new Set([
    raw,
    raw && /^\d+$/.test(raw) ? `${raw} songs` : '',
    raw && raw === '1' ? '1 song (a single)' : '',
  ].filter(Boolean))];
  let lastError = null;
  const direct = await selectOptionByDom(locator, candidates);
  if (direct) return;
  for (const candidate of candidates.length ? candidates : ['']) {
    try {
      await locator.selectOption(candidate, { timeout });
      return;
    } catch (err) {
      lastError = err;
    }
    try {
      await locator.selectOption({ label: candidate }, { timeout: Math.min(timeout || 15000, 5000) });
      return;
    } catch (err) {
      lastError = err;
    }
  }

  const matched = await locator.evaluate((select, desired) => {
    const want = String(desired || '').trim().toLowerCase();
    if (!want) return null;
    for (const option of Array.from(select.options || [])) {
      const text = String(option.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (text === want || text.startsWith(`${want} `)) return option.value;
    }
    return null;
  }, raw).catch(() => null);
  if (matched !== null && matched !== undefined) {
    await locator.selectOption(String(matched), { timeout });
    return;
  }

  throw lastError || new Error(`No matching select option for ${raw}`);
}

async function selectOptionByDom(locator, candidates = []) {
  return locator.evaluate((select, desiredValues) => {
    const desired = (desiredValues || []).map(value => String(value || '').trim().toLowerCase()).filter(Boolean);
    if (!desired.length || !select || !select.options) return false;
    for (const option of Array.from(select.options)) {
      const value = String(option.value || '').trim().toLowerCase();
      const text = String(option.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (desired.some(candidate => value === candidate || text === candidate || text.startsWith(`${candidate} `))) {
        select.value = option.value;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
    }
    return false;
  }, candidates).catch(() => false);
}

async function applyInputValue(locator, value, { timeout } = {}) {
  const input = await locator.evaluate(el => ({
    tag: String(el?.tagName || '').toLowerCase(),
    type: String(el?.getAttribute?.('type') || '').toLowerCase(),
  })).catch(() => null);
  if (input?.tag === 'input' && ['checkbox', 'radio'].includes(input.type)) {
    const shouldCheck = !['', '0', 'false', 'no', 'off', 'undefined', 'null'].includes(String(value ?? '').trim().toLowerCase());
    if (shouldCheck) {
      await locator.check({ timeout, force: true }).catch(async () => {
        await locator.evaluate(el => {
          el.checked = true;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        });
      });
    }
    return;
  }
  await locator.fill(String(value ?? ''), { timeout }).catch(async () => {
    await locator.evaluate((el, nextValue) => {
      el.value = String(nextValue ?? '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
  });
}

function fileFor(value, payload = {}, binding = null) {
  const direct = valueFor(value, payload, binding);
  if (direct && typeof direct === 'string' && !direct.startsWith('{{')) return direct;
  if (binding) {
    const bound = getRuntimeValue(payload, binding);
    if (bound) return bound;
  }
  if (payload.files && binding && payload.files[binding]) return payload.files[binding];
  return null;
}

function isDistroKidTrackTitleStep(step = {}) {
  const text = [
    step.id,
    step.binding,
    step.selector,
    ...(Array.isArray(step.fallbackSelectors) ? step.fallbackSelectors : []),
  ].filter(Boolean).join(' ');
  return /(?:^|[\s#"'=.])title[_-][a-f0-9-]{12,}/i.test(text) || /uploadFileTitle|Track\\?\s+\d+\\?\s+title|track_\d+/i.test(text);
}

function distroKidTrackIndex(step = {}) {
  const text = [
    step.id,
    step.binding,
    step.selector,
    ...(Array.isArray(step.fallbackSelectors) ? step.fallbackSelectors : []),
  ].filter(Boolean).join(' ');
  const classMatch = text.match(/track[_-](\d+)/i);
  if (classMatch) return Number(classMatch[1]);
  const labelMatch = text.match(/Track\\?\s+(\d+)\\?\s+title/i);
  if (labelMatch) return Number(labelMatch[1]);
  const uploadMatch = text.match(/js-track-upload-(\d+)/i);
  if (uploadMatch) return Number(uploadMatch[1]);
  return null;
}

function distroKidTrackValue(payload = {}, oneBasedIndex, keys = []) {
  const track = distroKidTracksFromPayload(payload)[Number(oneBasedIndex) - 1];
  if (!track || typeof track !== 'object') return undefined;
  for (const key of keys) {
    if (track[key] !== undefined && track[key] !== null && track[key] !== '') return track[key];
  }
  return undefined;
}

function distroKidTracksFromPayload(payload = {}) {
  const candidates = [
    payload?.canonical?.tracks,
    payload?.tracks,
    payload?.inputs?.tracks,
    payload?.album?.tracks,
    payload?.release?.tracks,
  ];
  return candidates.find(Array.isArray) || [];
}

function distroKidAudioFilesFromPayload(payload = {}) {
  const files = [];
  for (const track of distroKidTracksFromPayload(payload)) {
    const filePath = track?.audioPath || track?.audio_path || track?.audio_file || track?.audioFile || track?.file || track?.path;
    if (filePath) files.push(filePath);
  }
  const audioAssets = Array.isArray(payload?.assets)
    ? payload.assets.filter(asset => /audio|track|file/i.test(String(asset?.type || asset?.id || asset?.role || '')))
    : [];
  for (const asset of audioAssets) {
    const filePath = asset.path || asset.filePath || asset.sourcePath;
    if (filePath) files.push(filePath);
  }
  if (payload?.files?.file) files.push(payload.files.file);
  return [...new Set(files.filter(Boolean))];
}

function distroKidCreditValue(payload = {}, step = {}, key) {
  const trackCredit = distroKidTrackValue(payload, 1, ['appleMusicCredits', 'apple_music_credits']) || {};
  const rootCredit = payload?.canonical?.apple_music_credits || payload?.distrokid_payload?.apple_music_credits || {};
  const credit = /producer/i.test(`${step.id || ''} ${step.binding || ''}`)
    ? (trackCredit.producer || rootCredit.producer || {})
    : (trackCredit.performer || rootCredit.performer || {});
  if (credit?.[key]) return credit[key];
  if (key === 'role') return /producer/i.test(`${step.id || ''} ${step.binding || ''}`) ? 'Executive Producer' : 'Performer';
  return /producer/i.test(`${step.id || ''} ${step.binding || ''}`) ? 'Kenneth Chapman' : 'Pancake Robot';
}

function isDistroKidAudioUploadStep(step = {}) {
  const text = [step.id, step.binding, step.selector, ...(Array.isArray(step.fallbackSelectors) ? step.fallbackSelectors : [])].filter(Boolean).join(' ');
  return /\bfile\b/i.test(String(step.binding || '')) && /js-track-upload|audioFileInput|uploadForm|input\[name="file"\]/i.test(text);
}

function isDistroKidAiGateStep(step = {}) {
  const text = [step.id, step.binding, step.selector, ...(Array.isArray(step.fallbackSelectors) ? step.fallbackSelectors : [])].filter(Boolean).join(' ');
  return /ai[_-]?gate|distroAiGate/i.test(text);
}

function isDistroKidAiRecordingScopeStep(step = {}) {
  const text = [step.id, step.binding, step.selector, ...(Array.isArray(step.fallbackSelectors) ? step.fallbackSelectors : [])].filter(Boolean).join(' ');
  return /ai[_-]?recording[_-]?scope|distroAiRecordingScope/i.test(text);
}

function isDistroKidCreditRoleStep(step = {}) {
  const text = [step.id, step.binding, step.selector, ...(Array.isArray(step.fallbackSelectors) ? step.fallbackSelectors : [])].filter(Boolean).join(' ');
  return /track1(?:Performer|Producer)1Role|performer-role|producer-role/i.test(text);
}

function isDistroKidCreditNameStep(step = {}) {
  const text = [step.id, step.binding, step.selector, ...(Array.isArray(step.fallbackSelectors) ? step.fallbackSelectors : [])].filter(Boolean).join(' ');
  return /(?:performerName|producerName|performer-name|producer-name|track-1-(?:performer|producer)-1-name)/i.test(text);
}

async function locateDistroKidTrackTitle(page, oneBasedIndex, timeout) {
  const index = Number(oneBasedIndex);
  if (!index) return null;
  const selectors = [
    `input.uploadFileTitle.track_${index}`,
    `input[name^="title_"].track_${index}`,
    `input[aria-label="Track ${index} title"]`,
  ];
  for (const selector of selectors) {
    const loc = page.locator(selector).first();
    try {
      await loc.waitFor({ state: 'visible', timeout: Math.min(timeout || 15000, 5000) });
      return loc;
    } catch {}
  }
  const indexed = page.locator('input.uploadFileTitle, input[name^="title_"]').nth(index - 1);
  try {
    await indexed.waitFor({ state: 'visible', timeout: Math.min(timeout || 15000, 5000) });
    return indexed;
  } catch {}
  return null;
}

async function locateDistroKidAiGate(page, value, timeout) {
  const desired = String(value ?? '').trim();
  const selectors = [
    desired ? `input[name^="ai_gate_"][value="${cssEscape(desired)}"]` : '',
    desired ? `input.distroAiGate[value="${cssEscape(desired)}"]` : '',
    'input[name^="ai_gate_"]',
    'input.distroAiGate',
  ].filter(Boolean);
  return firstAttachedLocator(page, selectors, timeout);
}

async function locateDistroKidAiRecordingScope(page, value, timeout) {
  const desired = String(value ?? '').trim();
  const selectors = [
    desired ? `input.distroAiRecordingScope[track="1"][value="${cssEscape(desired)}"]` : '',
    desired ? `input.distroAiRecordingScope[value="${cssEscape(desired)}"]` : '',
    desired ? `input[name*="ai"][value="${cssEscape(desired)}"]` : '',
    'input.distroAiRecordingScope[track="1"]',
    'input.distroAiRecordingScope',
  ].filter(Boolean);
  return firstAttachedLocator(page, selectors, timeout);
}

async function locateDistroKidCreditRole(page, step, timeout) {
  const isProducer = /producer/i.test(`${step.id || ''} ${step.binding || ''} ${step.selector || ''}`);
  const selectors = isProducer
    ? ['#track-1-producer-1-role', 'select.producer-role', 'select[id*="producer"][id*="role"]']
    : ['#track-1-performer-1-role', 'select.performer-role', 'select[id*="performer"][id*="role"]'];
  return firstAttachedLocator(page, selectors, timeout);
}

async function locateDistroKidCreditName(page, step, timeout) {
  const isProducer = /producer/i.test(`${step.id || ''} ${step.binding || ''} ${step.selector || ''}`);
  const selectors = isProducer
    ? ['#track-1-producer-1-name', 'input.producer-name', 'input[name="producer-name"]', 'input[id*="producer"][id*="name"]']
    : ['#track-1-performer-1-name', 'input.performer-name', 'input[name="performer-name"]', 'input[id*="performer"][id*="name"]'];
  return firstAttachedLocator(page, selectors, timeout);
}

async function firstAttachedLocator(page, selectors, timeout) {
  for (const selector of selectors) {
    const loc = page.locator(selector).first();
    try {
      await loc.waitFor({ state: 'attached', timeout: Math.min(timeout || 15000, 5000) });
      return loc;
    } catch {}
  }
  return null;
}

async function uploadDistroKidTrackAudioFiles(page, payload = {}, { timeout } = {}) {
  const files = distroKidAudioFilesFromPayload(payload);
  const uploaded = [];
  for (const [i, filePath] of files.entries()) {
    const index = i + 1;
    const selectors = [
      `#js-track-upload-${index}`,
      `input[type="file"][id="js-track-upload-${index}"]`,
      `div.track_${index} input[type="file"]`,
    ];
    let lastError = null;
    for (const selector of selectors) {
      const loc = page.locator(selector).first();
      try {
        await loc.waitFor({ state: 'attached', timeout: Math.min(timeout || 15000, 8000) });
        await loc.setInputFiles(filePath, { timeout });
        uploaded.push({ role: `track_${index}_audio`, selector, path: filePath, status: 'uploaded' });
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
      }
    }
    if (lastError) throw new Error(`could not upload track ${index} audio file ${filePath}: ${lastError.message}`);
  }
  return uploaded;
}

function resolveStepUrl(url, payload = {}) {
  if (typeof url !== 'string' || !hasTemplateVars(url)) return url;
  try {
    return resolveTemplate(url.replace(/\{\{payload\./g, '{{'), payload);
  } catch (err) {
    const available = err.availableVariables || availableRuntimeVars(payload);
    throw new Error(`Unresolved template variable "${err.variable || err.token || 'unknown'}" in URL "${url}". Available variables: ${available.join(', ') || '(none)'}`);
  }
}

async function infer(page, outputId, expectedOutputs = []) {
  const id = String(outputId || '').toLowerCase();
  const meta = expectedOutputs.find(o => String(o.id || '').toLowerCase() === id) || {};
  if (/url|link/.test(id) || /external_link/i.test(meta.scope || '')) return page.url();
  const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  const patterns = [/(\d[\d,]*)\s+(rows|records|results|items)\b/i, /(total|count)\D{0,20}(\d[\d,]*)/i, /(\d[\d,]*)\s+of\s+(\d[\d,]*)/i];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[0].trim();
  }
  return text.trim().slice(0, 500) || null;
}

function withExpectedOutputs(captured, expectedOutputs = []) {
  const out = { ...captured };
  for (const e of expectedOutputs) {
    const id = e.id || e.name || e.output;
    if (!id || out[id]) continue;
    out[id] = { status: 'pending', value: null, required: e.required !== false, selector: e.selector || null };
  }
  return out;
}

async function shot(page, dir, name) {
  try {
    ensureDir(dir);
    const filename = `${safeSegment(name)}-${Date.now()}.png`;
    const filePath = path.join(dir, filename);
    await page.screenshot({ path: filePath, fullPage: true });
    return { name: filename, path: filePath, pageUrl: page.url() };
  } catch { return null; }
}

async function pageDiagnostic(page) {
  try {
    const title = await page.title().catch(() => null);
    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 1200) || '').catch(() => '');
    return { pageUrl: page.url(), pageTitle: title, bodyTextPreview: bodyText };
  } catch {
    return {};
  }
}

function pushUnique(list, item) {
  if (!item?.path) return;
  if (!list.some(x => x?.path === item.path)) list.push(item);
}

function uniqueByPath(items = []) {
  const map = new Map();
  for (const item of items) if (item?.path && !map.has(item.path)) map.set(item.path, item);
  return [...map.values()];
}

function hostFromStep(step = {}) {
  try { return new URL(step.url).hostname.replace(/^www\./, ''); } catch { return null; }
}

function bestOutputTab(tabs = []) {
  return tabs.find(t => !t.requiresAuth)?.id || tabs[tabs.length - 1]?.id || tabs[0]?.id || 'tab1';
}

function safeSegment(value = '') {
  return String(value || '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
}

function safeName(value = '') {
  return safeSegment(value).slice(0, 120) || 'artifact';
}

function escapeRegex(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cssEscape(value = '') {
  return String(value).replace(/["\\]/g, '\\$&');
}

function clean(obj) {
  if (Array.isArray(obj)) return obj.map(clean).filter(v => v !== undefined && v !== null);
  if (!obj || typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v) && !v.length) continue;
    out[k] = clean(v);
  }
  return out;
}
