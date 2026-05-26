// Pure run-plan builder for repeat-group workflows.
//
// Takes a parsed repeat group config + manifest JSON and produces an ordered,
// deterministic execution plan. A browser executor can walk these steps without
// knowing anything about the wizard or AUTOMATION_REQUEST format.
//
// Step types:
//   fill_global    — fill a non-file field once (album-level)
//   upload_global  — upload a file field once (album art)
//   repeat_iteration — one iteration of the repeat group; contains sub-steps:
//     ensure_section — click addAction (or verify first section already exists)
//     fill_item      — fill a non-file field in the repeated section
//     upload_item    — upload a file in the repeated section
//   human_checkpoint — always the final step; executor must stop here

const FILE_EXTENSIONS = /\.(wav|mp3|flac|aiff|m4a|ogg|png|jpg|jpeg|gif|webp|svg|pdf|zip)$/i;
// Match camelCase upload-indicator tokens — use explicit casing to avoid
// false positives like "artistName" matching bare "art".
const FILE_SOURCE_WORDS = /(Path|File)$|Audio|Artwork|Image|Cover|Upload/;

function isFilePath(value) {
  if (typeof value !== 'string') return false;
  return FILE_EXTENSIONS.test(value);
}

function isUploadField(source, value) {
  return FILE_SOURCE_WORDS.test(source) || isFilePath(value);
}

// Resolve a dot-notation path against an object.
// resolvePath({a:{b:1}}, 'a.b') → 1
function resolvePath(obj, dotPath) {
  if (!dotPath || obj == null) return undefined;
  return String(dotPath).split('.').reduce((acc, k) => acc?.[k], obj);
}

// Build an ordered run plan from a single repeat group config + manifest.
//
// repeatGroup: one entry from parsedRequest.repeatGroups
// manifest:    the input manifest JSON (already parsed)
//
// Returns { steps: [...], warnings: string[] }
export function buildRunPlan(repeatGroup, manifest) {
  const steps = [];
  const warnings = [];

  const {
    name: groupName,
    source,
    itemName,
    globalFields = [],
    itemFields = [],
    repeatAction,
  } = repeatGroup;

  // Resolve the source array from the manifest
  const sourceKey = (source || '').replace(/\[\]$/, '');
  const rawItems = resolvePath(manifest, sourceKey);

  if (!Array.isArray(rawItems)) {
    warnings.push(
      `Repeat group "${groupName}": source "${source}" resolved to ${rawItems === undefined ? 'undefined' : typeof rawItems} in manifest — expected an array.`
    );
  }
  const items = Array.isArray(rawItems) ? rawItems : [];

  // Phase 1: global fills and uploads (album-level, happens once)
  for (const fieldSource of globalFields) {
    const value = resolvePath(manifest, fieldSource);
    const upload = isUploadField(fieldSource, value);
    steps.push({
      type: upload ? 'upload_global' : 'fill_global',
      groupName,
      source: fieldSource,
      value: value ?? null,
    });
  }

  // Phase 2: one repeat_iteration per item
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const iterSteps = [];

    // Ensure the DOM section exists for this item.
    // First section usually already exists; additional ones require clicking repeatAction.
    iterSteps.push({
      type: 'ensure_section',
      groupName,
      itemIndex: i,
      ...(i === 0
        ? { note: 'First section — verify it exists in DOM; do not click add action.' }
        : { repeatAction: repeatAction ?? null }),
    });

    // Fill / upload per-item fields
    for (const field of itemFields) {
      const fieldName = typeof field === 'string' ? field : field.name;
      const fieldSource = typeof field === 'string' ? field : (field.source ?? field.name);

      // Strip the itemName prefix to get the path relative to the item object.
      // "track.trackTitle" → "trackTitle" when itemName = "track"
      const prefix = itemName + '.';
      const relPath = fieldSource.startsWith(prefix)
        ? fieldSource.slice(prefix.length)
        : fieldSource;

      const value = resolvePath(item, relPath);
      const upload = isUploadField(fieldSource, value);

      iterSteps.push({
        type: upload ? 'upload_item' : 'fill_item',
        groupName,
        itemIndex: i,
        fieldName,
        source: fieldSource,
        value: value ?? null,
      });
    }

    steps.push({
      type: 'repeat_iteration',
      groupName,
      itemIndex: i,
      itemAlias: itemName,
      steps: iterSteps,
    });
  }

  // Phase 3: human checkpoint — always the final step, never skipped
  steps.push({
    type: 'human_checkpoint',
    reason: `All ${items.length} ${groupName} filled. Human must review, check legal certification, and click final submit.`,
    blocked: ['Submit', 'Upload to stores', 'Release', 'Distribute', 'Send to stores'],
  });

  return { steps, warnings };
}

// Validate a completed run plan.
// Returns [{ level: 'error'|'warning', message }]
export function validateRunPlan(plan, repeatGroup) {
  const issues = [];
  const { steps = [], warnings = [] } = plan;

  for (const w of warnings) {
    issues.push({ level: 'warning', message: w });
  }

  // Checkpoint must exist and be the last step
  const lastStep = steps[steps.length - 1];
  if (!lastStep || lastStep.type !== 'human_checkpoint') {
    issues.push({
      level: 'error',
      message: 'Run plan must end with a human_checkpoint step — final submit must never be automated.',
    });
  }

  // Global steps must all precede the first repeat_iteration
  const firstIterIdx = steps.findIndex(s => s.type === 'repeat_iteration');
  const lastGlobalIdx = steps.reduce(
    (max, s, i) => (s.type === 'fill_global' || s.type === 'upload_global') ? i : max,
    -1
  );
  if (firstIterIdx !== -1 && lastGlobalIdx > firstIterIdx) {
    issues.push({
      level: 'error',
      message: 'Global fill/upload steps must all precede repeat_iteration steps.',
    });
  }

  // Each repeat_iteration must contain an ensure_section as its first sub-step
  for (const iter of steps.filter(s => s.type === 'repeat_iteration')) {
    const firstSub = iter.steps?.[0];
    if (!firstSub || firstSub.type !== 'ensure_section') {
      issues.push({
        level: 'error',
        message: `repeat_iteration[${iter.itemIndex}] must start with an ensure_section step.`,
      });
    }
    // Iterations after the first must have a repeatAction on their ensure_section
    if (iter.itemIndex > 0 && firstSub?.type === 'ensure_section' && !firstSub.repeatAction) {
      issues.push({
        level: 'warning',
        message: `repeat_iteration[${iter.itemIndex}] ensure_section has no repeatAction — executor will not know how to add a new section.`,
      });
    }
  }

  // Warn if source array produced no iterations
  const iterations = steps.filter(s => s.type === 'repeat_iteration');
  if (iterations.length === 0 && (repeatGroup?.source || '').endsWith('[]')) {
    issues.push({
      level: 'warning',
      message: 'Run plan has 0 repeat_iterations — manifest source array is empty.',
    });
  }

  return issues;
}

// Build a run plan from a generic automation package JSON object.
//
// The package format (new, single-file):
//   {
//     workflowId, target, globals, defaults, assets,
//     repeatGroups: [{ id, label, itemLabel, createAction, items: [{ fields, assets }] }],
//     humanCheckpoints: [{ id, label }]
//   }
//
// Returns { steps, warnings }
export function buildRunPlanFromPackage(pkg) {
  const steps = [];
  const warnings = [];

  // Phase 1: global fills (from pkg.globals)
  for (const [key, value] of Object.entries(pkg.globals || {})) {
    const upload = isUploadField(key, value);
    steps.push({ type: upload ? 'upload_global' : 'fill_global', source: key, value: value ?? null });
  }

  // Phase 1b: global asset uploads (from pkg.assets)
  for (const [key, value] of Object.entries(pkg.assets || {})) {
    steps.push({ type: 'upload_global', source: key, value: value ?? null });
  }

  // Phase 2: repeat groups
  for (const rg of pkg.repeatGroups || []) {
    const items = rg.items || [];
    if (items.length === 0) {
      warnings.push(`Repeat group "${rg.id || rg.label}": no items — no iterations will be generated.`);
    }

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const iterSteps = [];

      // ensure_section
      iterSteps.push({
        type: 'ensure_section',
        groupName: rg.id || rg.label,
        itemIndex: i,
        ...(i === 0
          ? { note: `First ${rg.itemLabel || 'item'} — verify section exists in DOM; do not click add action.` }
          : { repeatAction: rg.createAction ?? null }),
      });

      // Merge defaults with item fields (item values override defaults)
      const resolvedFields = { ...(pkg.defaults || {}), ...(item.fields || {}) };

      for (const [fieldName, value] of Object.entries(resolvedFields)) {
        const fromDefault = !(fieldName in (item.fields || {}));
        const upload = isUploadField(fieldName, value);
        iterSteps.push({
          type: upload ? 'upload_item' : 'fill_item',
          groupName: rg.id || rg.label,
          itemIndex: i,
          fieldName,
          source: fieldName,
          value: value ?? null,
          fromDefault,
        });
      }

      // Item assets (always upload)
      for (const [fieldName, value] of Object.entries(item.assets || {})) {
        iterSteps.push({
          type: 'upload_item',
          groupName: rg.id || rg.label,
          itemIndex: i,
          fieldName,
          source: fieldName,
          value: value ?? null,
          fromDefault: false,
        });
      }

      steps.push({
        type: 'repeat_iteration',
        groupName: rg.id || rg.label,
        itemIndex: i,
        steps: iterSteps,
      });
    }
  }

  // Phase 2b: captured outputs — click the trigger action (if any), then read the element
  for (const output of pkg.capturedOutputs || []) {
    const selector = output.selector || (output.id ? `#${output.id}` : null);
    if (!selector) continue;
    if (output.captureAfter) {
      steps.push({
        type: 'click_safe_action',
        selector: output.captureAfter,
        label: output.captureAfter,
      });
    }
    steps.push({
      type: 'capture_output',
      outputId: output.id,
      selector,
    });
  }

  // Phase 3: human checkpoint
  const checkpoint = (pkg.humanCheckpoints || [])[0];
  steps.push({
    type: 'human_checkpoint',
    reason: checkpoint?.label || 'Review before final submit.',
    blocked: ['Submit', 'Confirm', 'Finalize', 'Distribute', 'Release', 'Send'],
  });

  return { steps, warnings };
}

// Count steps by type (including sub-steps inside repeat_iterations).
// Useful for assertions in tests.
export function countStepsByType(plan) {
  const counts = {};
  for (const step of plan.steps) {
    counts[step.type] = (counts[step.type] ?? 0) + 1;
    for (const sub of step.steps ?? []) {
      counts[sub.type] = (counts[sub.type] ?? 0) + 1;
    }
  }
  return counts;
}
