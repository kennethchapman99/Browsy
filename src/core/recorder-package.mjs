/**
 * Recorder package builder.
 *
 * Converts a session's canonical event log + session metadata into a
 * replay-ready package describing:
 *   - manifest          session id, source, start URL, time bounds, counts
 *   - events            the full, ordered event log
 *   - evidence          per-page screenshots and DOM snapshots
 *   - requiredAssets    files the workflow uploads — must be provided at
 *                       replay time as actual local files, with hashes
 *                       optional when the recorder couldn't safely compute them
 *   - producedArtifacts files the workflow downloads — recorded so replay
 *                       knows what to verify and where to find captured bytes
 *   - replayNotes       explicit notes about steps that cannot be safely
 *                       automated from observation alone (multi-tab handoffs,
 *                       clipboard pastes without a known source, dangerous
 *                       human-checkpoints, etc.). Each note is a structured
 *                       record, not a free-form string.
 *
 * Pure function — no file system, no network. Caller persists the result.
 */

import { UPLOAD_EVENT_TYPES, DOWNLOAD_EVENT_TYPES, deriveStatsFromEvents } from './observation-events.mjs';

const FILE_EVENT_TO_TRIGGER = {
  file_selected: 'file_input_change',
  file_dropped: 'drag_drop',
};

/**
 * Build the package from a session.
 *
 * @param {object} opts
 * @param {string} opts.sessionId
 * @param {string} opts.source
 * @param {string} [opts.startUrl]
 * @param {string} [opts.workflowId]
 * @param {number} [opts.startedAt]   — epoch ms
 * @param {number} [opts.finishedAt]  — epoch ms
 * @param {Array}  opts.events
 */
export function buildRecorderPackage({ sessionId, source, startUrl, workflowId, startedAt, finishedAt, events = [] } = {}) {
  if (!sessionId) throw new Error('sessionId required');
  const ordered = Array.isArray(events) ? events.slice() : [];

  const evidence = collectEvidence(ordered);
  const requiredAssets = collectRequiredAssets(ordered);
  const producedArtifacts = collectProducedArtifacts(ordered);
  const replayNotes = buildReplayNotes(ordered, { requiredAssets, producedArtifacts });
  const stats = deriveStatsFromEvents(ordered);

  return {
    schemaVersion: 'browsy.recorder-package.v1',
    manifest: {
      sessionId,
      source: source || null,
      workflowId: workflowId || null,
      startUrl: startUrl || null,
      startedAt: startedAt ? new Date(startedAt).toISOString() : null,
      finishedAt: finishedAt ? new Date(finishedAt).toISOString() : null,
      durationMs: startedAt && finishedAt ? Math.max(0, finishedAt - startedAt) : null,
      eventCount: ordered.length,
      stats,
    },
    events: ordered,
    evidence,
    requiredAssets,
    producedArtifacts,
    replayNotes,
  };
}

function collectEvidence(events) {
  const snapshots = [];
  for (const ev of events) {
    if (ev.type !== 'page_snapshot_captured') continue;
    const raw = ev.rawEvidence || {};
    snapshots.push({
      eventId: ev.id,
      pageId: ev.pageId || null,
      pageUrl: ev.pageUrl || raw.url || null,
      pageTitle: ev.pageTitle || raw.title || null,
      kind: raw.kind || 'page',
      hint: raw.hint || null,
      screenshotPath: raw.screenshotPath || null,
      domSnapshotPath: raw.domSnapshotPath || null,
      visibleTextSummary: raw.visibleTextSummary || null,
      viewport: raw.viewport || null,
      capturedAt: raw.capturedAt || ev.timestamp,
    });
  }
  return { snapshots };
}

function collectRequiredAssets(events) {
  const assets = [];
  let counter = 0;
  for (const ev of events) {
    if (!UPLOAD_EVENT_TYPES.includes(ev.type)) continue;
    const raw = ev.rawEvidence || {};
    const files = Array.isArray(raw.files) ? raw.files : [];
    if (files.length === 0) {
      counter++;
      assets.push({
        id: `asset_${counter}`,
        sourceEventId: ev.id,
        pageId: ev.pageId || null,
        selector: ev.selector || null,
        selectorCandidates: raw.selectorCandidates || [],
        label: raw.label || raw.targetLabel || null,
        captureTrigger: FILE_EVENT_TO_TRIGGER[ev.type] || ev.type,
        accept: raw.accept || null,
        multiple: !!raw.multiple,
        fileName: null,
        size: null,
        type: null,
        lastModified: null,
        hash: null,
        replayRequirement: 'caller must provide a local file path at replay time',
      });
      continue;
    }
    for (const file of files) {
      counter++;
      assets.push({
        id: `asset_${counter}`,
        sourceEventId: ev.id,
        pageId: ev.pageId || null,
        selector: ev.selector || null,
        selectorCandidates: raw.selectorCandidates || [],
        label: raw.label || raw.targetLabel || null,
        captureTrigger: FILE_EVENT_TO_TRIGGER[ev.type] || ev.type,
        accept: raw.accept || null,
        multiple: !!raw.multiple,
        fileName: file && file.name || null,
        size: file && typeof file.size === 'number' ? file.size : null,
        type: file && file.type || null,
        lastModified: file && typeof file.lastModified === 'number' ? file.lastModified : null,
        // No hash — recorder never reads file contents, by design. Replay
        // mapping must declare a hash if integrity matters.
        hash: null,
        replayRequirement: 'caller must provide a local file path at replay time',
      });
    }
  }
  return assets;
}

function collectProducedArtifacts(events) {
  const artifacts = [];
  let counter = 0;
  for (const ev of events) {
    if (!DOWNLOAD_EVENT_TYPES.includes(ev.type)) continue;
    const raw = ev.rawEvidence || {};
    counter++;
    artifacts.push({
      id: `artifact_${counter}`,
      sourceEventId: ev.id,
      pageId: ev.pageId || null,
      kind: ev.type,
      suggestedFilename: raw.suggestedFilename || null,
      savedPath: raw.savedPath || null,
      size: raw.size ?? null,
      url: raw.url || null,
      error: raw.error || null,
      capturedAt: ev.timestamp,
    });
  }
  return artifacts;
}

function buildReplayNotes(events, { requiredAssets, producedArtifacts }) {
  const notes = [];

  if (requiredAssets.length > 0) {
    notes.push({
      id: 'note_required_assets',
      severity: 'info',
      summary: `${requiredAssets.length} file upload(s) captured`,
      detail: 'Replay must supply an asset mapping (`assetMap[assetId] = absolute path`). The recorder never copies uploaded bytes, only filename/size/type metadata.',
      events: requiredAssets.map(a => a.sourceEventId).filter(Boolean),
    });
  }
  if (producedArtifacts.length > 0) {
    notes.push({
      id: 'note_downloads',
      severity: 'info',
      summary: `${producedArtifacts.length} download event(s) captured`,
      detail: 'Replay will produce one or more downloads. Verify the saved file matches the expected filename/size before treating it as a captured output.',
      events: producedArtifacts.map(a => a.sourceEventId).filter(Boolean),
    });
  }

  const popupCount = events.filter(e => e.type === 'popup_opened').length;
  if (popupCount > 0) {
    notes.push({
      id: 'note_popups',
      severity: 'warning',
      summary: `${popupCount} popup window(s) opened during capture`,
      detail: 'Workflows that open popup windows are inherently fragile — popup blockers, auth handoffs, and cross-origin restrictions can change replay behavior. Mark these as manual checkpoints unless a deterministic selector strategy is verified.',
      events: events.filter(e => e.type === 'popup_opened').map(e => e.id),
    });
  }

  const distinctPageIds = new Set(events.map(e => e.pageId).filter(Boolean));
  if (distinctPageIds.size > 1) {
    notes.push({
      id: 'note_multi_tab',
      severity: 'warning',
      summary: `${distinctPageIds.size} tabs/pages observed`,
      detail: 'Multi-tab workflows require the replay engine to track all opened pages and route actions to the correct one. Verify each tab transition has a selector or URL pattern before automating.',
      events: [],
    });
  }

  const frameIds = new Set(events.filter(e => e.frameId).map(e => e.frameId));
  if (frameIds.size > 0) {
    notes.push({
      id: 'note_frames',
      severity: 'info',
      summary: `${frameIds.size} sub-frame(s) interacted with`,
      detail: 'Replay must scope selectors to the originating frame. Cross-origin frames will not accept the injected recorder script — verify selector strategy for those manually.',
      events: events.filter(e => e.frameId).map(e => e.id),
    });
  }

  const clipboardPastes = events.filter(e => e.type === 'paste_detected');
  if (clipboardPastes.length > 0) {
    notes.push({
      id: 'note_clipboard_paste',
      severity: 'warning',
      summary: `${clipboardPastes.length} clipboard paste(s) captured`,
      detail: 'Replay cannot reproduce a real clipboard. Each paste must be converted into an explicit value-set step (workflow input) or marked as a manual step. The captured `textPreview` is a length-capped preview only.',
      events: clipboardPastes.map(e => e.id),
    });
  }

  const dangerousEvents = events.filter(e =>
    e.type === 'dangerous_action_candidate_detected' || e.type === 'user_marked_dangerous_action');
  if (dangerousEvents.length > 0) {
    notes.push({
      id: 'note_dangerous_actions',
      severity: 'warning',
      summary: `${dangerousEvents.length} dangerous action candidate(s) detected`,
      detail: 'Dangerous actions stay behind a human checkpoint — replay must never auto-click these unless explicitly approved via the safety policy.',
      events: dangerousEvents.map(e => e.id),
    });
  }

  const downloadFailures = events.filter(e => e.type === 'download_failed');
  if (downloadFailures.length > 0) {
    notes.push({
      id: 'note_download_failures',
      severity: 'error',
      summary: `${downloadFailures.length} download(s) failed during capture`,
      detail: 'A failed download during observation usually means the recorder cannot prove the workflow produces a captured artifact. Re-record or mark the step as manual.',
      events: downloadFailures.map(e => e.id),
    });
  }

  return notes;
}
