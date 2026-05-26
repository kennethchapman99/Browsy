/**
 * Render a human-readable "Captured Workflow Preview" from an observation
 * object built by `buildObservationFromEvents()`.
 *
 * The preview is intentionally meant for a non-engineer reviewer — it lists
 * what the capture pipeline thinks it saw, with clear sections for fields,
 * repeat groups, manual-only actions, suggested assertions, evidence, and
 * selector confidence warnings. The reviewer should be able to scan it and
 * say "yes that's the workflow I just walked through" before any automation
 * is generated.
 *
 * Pure function — does not touch the file system.
 */

/**
 * @param {object} obs — the output of buildObservationFromEvents()
 * @returns {string}   — markdown preview
 */
export function renderObservationPreview(obs = {}) {
  const lines = [];
  const push = (s = '') => lines.push(s);
  const sourceLabel = obs.captureSourceLabel || obs.captureSource || 'unknown';

  push(`# Captured Workflow Preview: ${obs.workflowId || 'observed-workflow'}`);
  push('');
  push(`> A non-engineer should be able to read this preview and confirm "yes,`);
  push(`> that matches the workflow I just walked through". If anything below`);
  push(`> looks wrong, the captured observation is wrong — fix it before`);
  push(`> generating automation.`);
  push('');
  push(`- **Capture source:** ${sourceLabel}`);
  push(`- **Workflow ID:** \`${obs.workflowId || ''}\``);
  push(`- **Captured at:** ${obs.capturedAt || ''}`);
  push(`- **Start URL:** ${obs.sourceUrl || '(none)'}`);
  push(`- **Mode:** ${obs.mode || ''}`);
  push('');

  // ── Pages / states ─────────────────────────────────────────────────────────
  push('## Pages / states observed');
  push('');
  if (!obs.pages || obs.pages.length === 0) {
    push('_No pages captured._');
  } else {
    for (const p of obs.pages) {
      push(`- **${p.name}** — ${escapeMd(p.title || '(no title)')}`);
      push(`  - URL: \`${p.url}\``);
      const ev = p.evidence || {};
      const snaps = Array.isArray(ev.snapshots) && ev.snapshots.length > 0
        ? ev.snapshots
        : (Array.isArray(ev.screenshots) ? ev.screenshots : []);
      if (snaps.length === 0) {
        push(`  - Evidence: _none captured_ — ${ev.reason || 'capture hook did not fire for this page'}`);
        push(`    - Screenshot: not captured`);
        push(`    - DOM snapshot: not captured`);
        push(`    - Visible text summary: not captured`);
      } else {
        for (const s of snaps) {
          const stamp = s.capturedAt || '(unknown time)';
          const hint = s.hint ? ` "${escapeMd(s.hint)}"` : '';
          push(`  - Evidence (${escapeMd(s.kind || 'page')}${hint}) captured at ${stamp}:`);
          push(`    - Screenshot: ${s.screenshotPath ? `\`${s.screenshotPath}\`` : (s.screenshotError ? `_failed (${escapeMd(s.screenshotError)})_` : '_not captured_')}`);
          push(`    - DOM snapshot: ${s.domSnapshotPath ? `\`${s.domSnapshotPath}\`` : (s.domSnapshotError ? `_failed (${escapeMd(s.domSnapshotError)})_` : '_not captured_')}`);
          const vts = s.visibleTextSummary;
          push(`    - Visible text summary: ${vts ? `${escapeMd(vts)}` : '_not captured_'}`);
          if (s.viewport && typeof s.viewport.width === 'number') {
            push(`    - Viewport: ${s.viewport.width}×${s.viewport.height}`);
          }
        }
      }
      // Per-page selector confidence warnings — these are the selectors whose
      // top candidate is `low` and whose action sits on THIS page. We list
      // them inline so the reviewer can see "this is what's shaky on stage 2"
      // without cross-referencing the global warnings section.
      const pageWarnings = (obs.selectorWarnings || []).filter(w => w && w.pageUrl === p.url);
      if (pageWarnings.length > 0) {
        push(`  - Selector confidence warnings on this page: ${pageWarnings.length}`);
        for (const w of pageWarnings) {
          push(`    - \`${w.kind}\` **${escapeMd(w.label)}** — selector \`${w.selector || '(none)'}\``);
        }
      }
    }
  }
  push('');

  // ── Fields ────────────────────────────────────────────────────────────────
  push('## Fields detected');
  push('');
  push(`### Global fields (${(obs.globalFields || []).length})`);
  push('');
  if (!obs.globalFields || obs.globalFields.length === 0) {
    push('_None._');
  } else {
    for (const f of obs.globalFields) {
      push(`- \`${f.id}\` — ${escapeMd(f.label || f.id)} (${f.inputType}${f.required ? ', required' : ''}) — selector: \`${f.selector || '(none)'}\` _(${f.selectorConfidence || 'low'} confidence)_`);
    }
  }
  push('');
  push(`### Global assets (file inputs) (${(obs.globalAssets || []).length})`);
  push('');
  if (!obs.globalAssets || obs.globalAssets.length === 0) {
    push('_None._');
  } else {
    for (const a of obs.globalAssets) {
      push(`- \`${a.id}\` — ${escapeMd(a.label || a.id)} (file${a.required ? ', required' : ''}) — selector: \`${a.selector || '(none)'}\` _(${a.selectorConfidence || 'low'} confidence)_`);
    }
  }
  push('');

  // ── Repeat groups ─────────────────────────────────────────────────────────
  push(`## Repeat groups (${(obs.repeatGroups || []).length})`);
  push('');
  if (!obs.repeatGroups || obs.repeatGroups.length === 0) {
    push('_No repeat groups detected._');
  } else {
    for (const g of obs.repeatGroups) {
      push(`### ${escapeMd(g.label || g.id)}`);
      push('');
      push(`- ID: \`${g.id}\``);
      push(`- Item label: \`${g.itemLabel || 'item'}\``);
      push(`- Add button selector: \`${g.addButtonSelector || g.selector || '(none)'}\` _(${g.selectorConfidence || 'low'} confidence)_`);
      push(`- Detected by: \`${g.detectedBy || 'unknown'}\` (heuristic confidence ${formatConfidence(g.heuristicConfidence)})`);
      if (g.fieldStems && g.fieldStems.length) {
        push(`- Field stems: ${g.fieldStems.map(s => `\`${s}\``).join(', ')}`);
      }
      const instances = g.instances || [];
      push(`- Instances captured: **${g.instanceCount ?? instances.length}**`);
      if (instances.length === 0) {
        push(`  - _No structured instances detected — the add-button label was seen but child fields were not clustered._`);
      } else {
        for (const inst of instances) {
          const parts = [];
          if (inst.fields && inst.fields.length) parts.push(`fields: ${inst.fields.map(f => `\`${f}\``).join(', ')}`);
          if (inst.assets && inst.assets.length) parts.push(`assets: ${inst.assets.map(a => `\`${a}\``).join(', ')}`);
          push(`  - **Instance ${inst.index}** — ${parts.join('; ') || '(no fields)'}`);
        }
      }
      push('');
    }
  }

  // ── Manual-only / dangerous actions ───────────────────────────────────────
  push(`## Manual-only / dangerous actions (${(obs.manualOnlyActions || []).length})`);
  push('');
  push('> These MUST stay manual. The runner stops here for human review.');
  push('');
  if (!obs.manualOnlyActions || obs.manualOnlyActions.length === 0) {
    push('_None detected. If a real publish / submit button exists on the captured pages, the heuristic missed it — re-check the raw event log._');
  } else {
    for (const a of obs.manualOnlyActions) {
      push(`- ⚠ **${escapeMd(a.label)}** — selector: \`${a.selector || '(none)'}\` _(${a.selectorConfidence || 'low'} confidence)_`);
      push(`  - Reason: ${escapeMd(a.reason || 'flagged as dangerous')}`);
      if (a.matchedKeyword) push(`  - Matched keyword: \`${a.matchedKeyword}\``);
      push(`  - Detected by: \`${a.detectedBy || 'unknown'}\` (heuristic confidence ${formatConfidence(a.heuristicConfidence)})`);
    }
  }
  push('');

  // ── Suggested assertions ──────────────────────────────────────────────────
  push(`## Suggested assertions / checkpoints (${(obs.suggestedAssertions || []).length})`);
  push('');
  push('> These are *not* automation steps. They are things the runner should');
  push('> verify before / after, and that a human reviewer should sanity-check.');
  push('');
  if (!obs.suggestedAssertions || obs.suggestedAssertions.length === 0) {
    push('_No assertions suggested._');
  } else {
    const byKind = groupBy(obs.suggestedAssertions, a => a.kind || 'other');
    for (const kind of Object.keys(byKind).sort()) {
      push(`### ${kind}`);
      push('');
      for (const a of byKind[kind]) {
        const selBit = a.selector ? ` — selector \`${a.selector}\` _(${a.selectorConfidence || 'low'})_` : '';
        push(`- ${escapeMd(a.label)}${selBit} _(confidence ${formatConfidence(a.confidence)})_`);
      }
      push('');
    }
  }

  // ── Selector confidence warnings ──────────────────────────────────────────
  push(`## Selector confidence warnings (${(obs.selectorWarnings || []).length})`);
  push('');
  if (!obs.selectorWarnings || obs.selectorWarnings.length === 0) {
    push('_No low-confidence selectors detected. Selectors look stable enough to drive automation against this fixture._');
  } else {
    for (const w of obs.selectorWarnings) {
      push(`- \`${w.kind}\` **${escapeMd(w.label)}** uses low-confidence selector \`${w.selector || '(none)'}\` — promote to a stable id / data-testid before automating.`);
    }
  }
  push('');

  // ── Event noise summary ───────────────────────────────────────────────────
  push('## Event noise reduction');
  push('');
  const n = obs.noiseReduction || {};
  push(`- Raw events: **${n.eventsBeforeDedupe ?? 0}**`);
  push(`- After dedupe: **${n.eventsAfterDedupe ?? 0}**`);
  push(`- Dropped overall: ${n.dropped ?? 0}`);
  push(`- Dropped field_detected pairs: ${n.droppedFieldDetected ?? 0}`);
  push(`- Dropped redundant repeat-group candidates: ${n.droppedRepeatCandidates ?? 0}`);
  push(`- Dropped redundant dangerous-action candidates: ${n.droppedDangerousCandidates ?? 0}`);
  push('');

  // ── Annotations ───────────────────────────────────────────────────────────
  if (Array.isArray(obs.annotations) && obs.annotations.length > 0) {
    push('## Human annotations');
    push('');
    for (const note of obs.annotations) push(`- ${escapeMd(note)}`);
    push('');
  }

  return lines.join('\n');
}

function groupBy(list, keyFn) {
  const out = {};
  for (const item of list) {
    const k = keyFn(item);
    if (!out[k]) out[k] = [];
    out[k].push(item);
  }
  return out;
}

function formatConfidence(c) {
  if (typeof c !== 'number') return String(c ?? '?');
  return c.toFixed(2);
}

function escapeMd(s) {
  if (s == null) return '';
  return String(s).replace(/\|/g, '\\|');
}
