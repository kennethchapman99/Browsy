// Autopilot orchestration — chains discover → field-map → dry-run into one pass
// and produces a single structured report of what is done and what still needs
// a human. This is the reusable core behind the `browsy autopilot` CLI command.
//
// It reuses the existing primitives only (no new browser/LLM logic):
//   launchBrowser + writeDiscoveryArtifacts   (discovery)
//   generateFieldMapForWorkflow               (LLM mapping w/ hallucination guard)
//   runWorkflowPackage                        (dry-run + result.json contract)
//
// Human boundaries are enforced, never bypassed: auth (mandatory-human),
// deep multi-step pages (exposed via one human recording pass), and
// dangerous-action / final-live approval (always human).
//
// Both the LLM caller and the per-page discovery step are injectable so the
// orchestration can be tested end-to-end without a browser or an API key.

import fs from 'fs';
import { join, resolve } from 'path';
import {
  OUTPUT_DIR,
  workflowDir, workflowAuthPath, workflowRunDir,
  exists, readJson, writeJson, writeText, safeId,
} from './paths.mjs';
import {
  resolveWorkflowAuthSites,
  mergeAuthStorageStates,
  getMissingWorkflowAuth,
  buildBlockedAuthRequests,
} from './auth.mjs';
import { launchBrowser, writeDiscoveryArtifacts } from './discovery.mjs';
import { generateCandidates, candidatesMarkdown } from './field-map-candidates.mjs';
import { generateFieldMapForWorkflow } from './field-map-llm.mjs';
import { runWorkflowPackage } from './workflow-run.mjs';
import { evaluateProjectReadiness } from './project-model.mjs';
import { isDangerousText } from './safety.mjs';
import { loadAndParseRequest } from './request-parser.mjs';
import { buildObservationFromEvents } from './observation-from-events.mjs';

export const LOW_CONFIDENCE_THRESHOLD = 0.7;

function loadWorkflowConfigMaybe(workflowId) {
  const configPath = join(workflowDir(workflowId), 'workflow.json');
  if (!exists(configPath)) return null;
  try { return readJson(configPath); } catch { return null; }
}

function resolveStorageState(workflowId) {
  const legacyPath = workflowAuthPath(workflowId);
  if (exists(legacyPath)) return legacyPath;
  const config = loadWorkflowConfigMaybe(workflowId);
  const requiredSiteIds = resolveWorkflowAuthSites(config || {})
    .filter(site => site.requiresAuth)
    .map(site => site.siteId);
  if (!requiredSiteIds.length) return undefined;
  const merged = mergeAuthStorageStates(requiredSiteIds);
  return (merged.cookies.length || merged.origins.length) ? merged : undefined;
}

function looksUnauthenticated(url = '') {
  return /accounts\.google\.com|\/login\b|\/signin\b|sign-in|auth/i.test(String(url || ''));
}

// Resolve a --from-recording value (session id OR a path to events.json /
// observation JSON) into a list of distinct, non-ephemeral page URLs.
export function recordingPageUrls(fromRecording) {
  if (!fromRecording) return [];
  let jsonPath = null;
  if (exists(fromRecording) && fs.statSync(fromRecording).isFile()) {
    jsonPath = resolve(fromRecording);
  } else {
    const candidate = join(OUTPUT_DIR, 'recordings', fromRecording, 'events.json');
    if (exists(candidate)) jsonPath = candidate;
  }
  if (!jsonPath) {
    throw new Error(`--from-recording: could not resolve "${fromRecording}" to a file or recording session (looked for output/recordings/${fromRecording}/events.json)`);
  }

  const data = readJson(jsonPath);
  let pages = [];
  if (data && Array.isArray(data.pages)) {
    pages = data.pages; // already a materialized observation
  } else {
    const events = Array.isArray(data) ? data : (data.events || []);
    pages = buildObservationFromEvents({ events }).pages || [];
  }

  const urls = [];
  for (const p of pages) {
    const u = p && p.url;
    if (!u || u === 'about:blank' || /^page_\d+$/.test(u)) continue;
    if (looksUnauthenticated(u)) continue; // drop SSO/login bounce pages
    if (!urls.includes(u)) urls.push(u);
  }
  return urls;
}

// Default per-page discovery: launch a browser, navigate, write artifacts.
// Returns the discovery object (with inputs/buttons/fileInputs).
async function defaultDiscoverPage({ url, runDir, storageState, headed }) {
  const { browser, page } = await launchBrowser({ headed, storageState });
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    return await writeDiscoveryArtifacts(page, runDir);
  } finally {
    await browser.close();
  }
}

function mdTableSimple(headers, rows) {
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map(r => `| ${r.join(' | ')} |`).join('\n');
  return [head, sep, body].join('\n');
}

export function renderAutopilotMarkdown(report) {
  const L = [];
  L.push(`# Autopilot report — ${report.workflowId}`);
  L.push('');
  L.push(`Generated: ${report.generatedAt}`);
  L.push(`Overall: **${report.overall}** · next: ${report.nextRequiredAction || '—'}`);
  L.push('');

  L.push('## Intent');
  L.push(`- field-mapping-instruction.md: ${report.intent.fieldMappingInstructionPresent ? 'present' : 'MISSING'}`);
  L.push(`- AUTOMATION_REQUEST.md: ${report.intent.automationRequestPresent ? 'present' : 'absent'}`);
  L.push('');

  L.push('## Pages discovered');
  if (report.discovery.length) {
    L.push(mdTableSimple(
      ['url', 'source', 'inputs', 'buttons', 'fileInputs', 'error'],
      report.discovery.map(d => [d.url, d.source, d.inputs ?? '—', d.buttons ?? '—', d.fileInputs ?? '—', d.error || ''])
    ));
  } else {
    L.push('_No discovery performed._');
  }
  L.push('');

  L.push('## Fields mapped');
  if (report.fieldMap) {
    L.push(`Mapped ${report.fieldMap.mapped}/${report.fieldMap.total} (model: ${report.fieldMap.model})`);
    const rows = Object.entries(report.fieldMap.fields || {}).map(([name, f]) =>
      [name, '`' + f.selector + '`', (report.fieldMap.confidence?.[name] ?? '—')]);
    if (rows.length) L.push(mdTableSimple(['field', 'selector', 'confidence'], rows));
  } else {
    L.push('_Field mapping not run._');
  }
  L.push('');

  L.push('## Needs human eyes');
  if (report.humanTouchpoints.length) {
    for (const t of report.humanTouchpoints) {
      const flag = t.blocking ? '🔴 BLOCKING' : '🟡';
      const extra = t.field ? ` (${t.field}${t.confidence != null ? ` @ ${t.confidence}` : ''})` : '';
      L.push(`- ${flag} **${t.type}**${extra} — ${t.reason}${t.command ? `\n      → \`${t.command}\`` : ''}`);
    }
  } else {
    L.push('_No outstanding human touchpoints._');
  }
  L.push('');

  L.push('## Dry-run');
  if (report.dryRun) {
    L.push(`- status: **${report.dryRun.status}**`);
    L.push(`- filled: ${report.dryRun.filledFields} · skipped: ${report.dryRun.skippedFields}`);
    L.push(`- next_required_action: ${report.dryRun.nextRequiredAction || '—'}`);
    L.push(`- result: ${report.dryRun.resultPath}`);
  } else {
    L.push('_Dry-run not run._');
  }
  L.push('');

  L.push('## Readiness');
  L.push('```json');
  L.push(JSON.stringify(report.readiness?.states || {}, null, 2));
  L.push('```');
  return L.join('\n') + '\n';
}

// Run the full autopilot loop. Returns { report, exitCode, jsonPath, mdPath }.
// Never calls process.exit — the caller decides what to do with exitCode.
export async function runAutopilot({
  workflowId,
  packagePath = null,
  model = 'claude-haiku-4-5-20251001',
  urls = [],
  fromRecording = null,
  headed = true,
  skipDiscovery = false,
  callLLM = null,           // injectable LLM (default: real Anthropic caller via generateFieldMapForWorkflow)
  discoverPageFn = defaultDiscoverPage, // injectable per-page discovery (for tests)
} = {}) {
  const workflow = safeId(workflowId);

  const report = {
    generatedAt: new Date().toISOString(),
    workflowId: workflow,
    intent: {},
    pagesPlanned: [],
    auth: { ok: true, missing: [], checked: [] },
    discovery: [],
    fieldMap: null,
    dryRun: null,
    humanTouchpoints: [],
    nextRequiredAction: null,
    readiness: null,
    overall: 'failed',
  };

  const finish = (status, code) => {
    report.overall = status;
    report.readiness = report.readiness || evaluateProjectReadiness({
      workflowDir: workflowDir(workflow),
      runsDir: join(OUTPUT_DIR, 'runs', workflow),
    });
    const runDir = workflowRunDir(workflow);
    const jsonPath = join(runDir, 'autopilot-report.json');
    const mdPath = join(runDir, 'autopilot-report.md');
    writeJson(jsonPath, report);
    writeText(mdPath, renderAutopilotMarkdown(report));
    return { report, exitCode: code, jsonPath, mdPath };
  };

  // Phase 0 — load intent + config
  const config = loadWorkflowConfigMaybe(workflow);
  if (!config) {
    throw new Error(`No workflow.json found for "${workflow}". Run: npm run init:workflow -- --id ${workflow}`);
  }
  report.intent.fieldMappingInstructionPresent = exists(join(workflowDir(workflow), 'field-mapping-instruction.md'));
  let requestFields = [];
  let automationRequestPresent = false;
  try {
    const req = loadAndParseRequest();
    requestFields = req.fieldsActions || [];
    automationRequestPresent = true;
  } catch {}
  report.intent.automationRequestPresent = automationRequestPresent;

  // Phase 1 — resolve the set of pages to discover
  const planned = [];
  const addUrl = (url, source) => {
    if (url && !planned.some(p => p.url === url)) planned.push({ url, source });
  };
  for (const u of (config.discovery_urls || [])) addUrl(u, 'discovery_urls');
  if (!planned.length && config.targets?.start_url) addUrl(config.targets.start_url, 'targets.start_url');
  for (const u of (Array.isArray(urls) ? urls : String(urls).split(',')).map(s => String(s).trim()).filter(Boolean)) {
    addUrl(u, '--urls');
  }
  if (fromRecording) {
    const recUrls = recordingPageUrls(fromRecording);
    for (const u of recUrls) addUrl(u, 'recording');
    report.humanTouchpoints.push({
      type: 'recording_for_deep_pages', blocking: false,
      reason: `Deep/multi-step pages exposed via one human recording pass (${recUrls.length} page URL(s) harvested).`,
    });
  }
  report.pagesPlanned = planned;
  if (!planned.length && !skipDiscovery) {
    throw new Error('No pages to discover. Add discovery_urls to workflow.json, pass urls, or fromRecording.');
  }

  // Phase 2 — auth check (mandatory-human gate)
  const missing = getMissingWorkflowAuth(config);
  if (missing.length) {
    report.auth.ok = false;
    report.auth.missing = missing.map(s => s.siteId);
    for (const r of buildBlockedAuthRequests(config)) {
      report.humanTouchpoints.push({
        type: 'blocked_auth_required', blocking: true,
        reason: `Auth missing/expired for ${r.siteName} — log in manually (Google/Okta reject automated login).`,
        command: r.command,
      });
    }
    report.nextRequiredAction = 'refresh_auth_profile';
    return finish('blocked', 4);
  }

  // Phase 3 — discovery on each page
  if (!skipDiscovery) {
    const storageState = resolveStorageState(workflow);
    for (const { url, source } of planned) {
      const entry = { url, source, runDir: null, inputs: null, buttons: null, fileInputs: null, error: null };
      const runDir = workflowRunDir(workflow);
      try {
        const discovery = await discoverPageFn({ url, runDir, storageState, headed });
        const data = generateCandidates(discovery, requestFields);
        writeJson(join(runDir, 'field-map.candidates.json'), data);
        writeText(join(runDir, 'field-map.candidates.md'), candidatesMarkdown(data));
        entry.runDir = runDir;
        entry.inputs = discovery.inputs?.length ?? 0;
        entry.buttons = discovery.buttons?.length ?? 0;
        entry.fileInputs = discovery.fileInputs?.length ?? 0;
        for (const b of (discovery.buttons || [])) {
          if (isDangerousText(b.text || b.ariaLabel || '')) {
            // Heads-up, not a hard block: the executor + safety policy already
            // enforce never-click. Surfaced so the human knows not to wire
            // automation to these controls.
            report.humanTouchpoints.push({
              type: 'dangerous_action', blocking: false,
              label: b.text || b.ariaLabel,
              reason: 'Dangerous control found on page — manual-only by safety policy; automation will never click it.',
            });
          }
        }
      } catch (err) {
        entry.error = err.message;
        report.humanTouchpoints.push({
          type: 'page_unreachable', blocking: false,
          reason: `Page failed to load (${url}) — verify URL/auth: ${err.message}`,
        });
      }
      report.discovery.push(entry);
    }
  }

  // Phase 4 — generate field map (LLM path, hallucination-guarded)
  try {
    const fm = await generateFieldMapForWorkflow({ workflowId: workflow, packagePath, model, callLLM });
    report.fieldMap = {
      path: fm.outPath,
      model: fm.model,
      mapped: Object.keys(fm.fieldMap).length,
      total: fm.packageFields.length,
      fields: fm.fieldMap,
      confidence: fm.confidence,
      unmapped: fm.unmapped,
    };
    for (const name of fm.unmapped) {
      report.humanTouchpoints.push({
        type: 'unmapped_intent_field', blocking: false, field: name,
        reason: `No confident selector — add one manually in ${fm.outPath}.`,
      });
    }
    for (const [name, conf] of Object.entries(fm.confidence)) {
      if (fm.fieldMap[name] && conf < LOW_CONFIDENCE_THRESHOLD) {
        report.humanTouchpoints.push({
          type: 'low_confidence_selector', blocking: false, field: name, confidence: conf,
          reason: `Mapped selector below ${LOW_CONFIDENCE_THRESHOLD} confidence — verify before live.`,
        });
      }
    }
  } catch (err) {
    report.humanTouchpoints.push({
      type: 'field_map_failed', blocking: true,
      reason: `Field mapping did not complete: ${err.message}`,
    });
  }

  // Phase 5 — dry-run (executor, reused; always dry_run, never live)
  try {
    const pkgPath = packagePath
      ? resolve(packagePath)
      : [
          join(workflowDir(workflow), 'workflow-package.local.json'),
          join(workflowDir(workflow), 'workflow-package.example.json'),
        ].find(p => exists(p));
    if (!pkgPath) throw new Error('No workflow package found for dry-run.');
    const outcome = await runWorkflowPackage({ packagePath: pkgPath, workflowId: workflow, modeOverride: 'dry_run' });
    const res = outcome.result || {};
    report.dryRun = {
      status: outcome.status,
      resultPath: outcome.resultPath,
      filledFields: Array.isArray(res.filled_fields) ? res.filled_fields.length : 0,
      skippedFields: Array.isArray(res.skipped_fields) ? res.skipped_fields.length : 0,
      clientActionRequests: res.client_action_requests || [],
      nextRequiredAction: res.next_required_action || null,
    };
    report.nextRequiredAction = report.nextRequiredAction || res.next_required_action || null;
    for (const r of (res.client_action_requests || [])) {
      report.humanTouchpoints.push({
        type: r.type, blocking: r.severity === 'block' || r.type === 'human_approval_required',
        reason: r.reason || 'Dry-run requested a client action.',
      });
    }
  } catch (err) {
    report.humanTouchpoints.push({
      type: 'dry_run_failed', blocking: true,
      reason: `Dry-run did not complete: ${err.message}`,
    });
  }

  // Phase 6 — readiness snapshot + verdict
  report.readiness = evaluateProjectReadiness({
    workflowDir: workflowDir(workflow),
    runsDir: join(OUTPUT_DIR, 'runs', workflow),
  });

  const blocking = report.humanTouchpoints.filter(t => t.blocking);
  const followups = report.humanTouchpoints.filter(t => !t.blocking && t.type !== 'recording_for_deep_pages');
  if (blocking.length) {
    report.nextRequiredAction = report.nextRequiredAction || 'resolve_blocking_touchpoints';
    return finish('blocked', 4);
  }
  if (followups.length) {
    report.nextRequiredAction = report.nextRequiredAction || 'review_low_confidence_and_dry_run';
    return finish('completed_with_followups', 3);
  }
  report.nextRequiredAction = report.nextRequiredAction || 'human_review_and_live_approval';
  return finish('ok', 0);
}
