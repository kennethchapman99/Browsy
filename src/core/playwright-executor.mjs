// Playwright executor for repeat-group run plans.
//
// Consumes a run plan produced by buildRunPlan() or buildRunPlanFromPackage()
// and drives a local fixture (or any browser page) through each step.
// Stops unconditionally at the human_checkpoint — final submit is never automated.
//
// Selector strategy (generic first, legacy fallback):
//   Global fields  → fieldMap override → data-browsy-field="<fieldName>"
//   Item sections  → [data-browsy-item-section] (fallback: .track-section)
//   Item fields    → fieldMap override → [data-browsy-item-field="<fieldName>"] (fallback: data-testid via ITEM_TESTID)
//   Section add    → repeatAction.selector

import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { pathToFileURL } from 'url';
import { safeClick, defaultSafetyPolicy } from './safety.mjs';
import { emitNeedsInput, emitDone } from './signals.mjs';

// Legacy testid map — used only as fallback when data-browsy-item-field is absent.
const ITEM_TESTID = {
  trackTitle:  'track-title',
  audioUpload: 'track-audio-upload',
  trackNumber: 'track-number',
  songwriter:  'track-songwriter',
  explicit:    'track-explicit',
};

function globalFieldSelector(source, fieldMap) {
  const fieldName = source.split('.').pop();
  if (fieldMap?.fields?.[fieldName]?.selector) {
    return fieldMap.fields[fieldName].selector;
  }
  return `[data-browsy-field="${fieldName}"]`;
}

function itemFieldSelector(fieldName, fieldMap) {
  if (fieldMap?.fields?.[fieldName]?.selector) {
    return fieldMap.fields[fieldName].selector;
  }
  const legacyTestid = ITEM_TESTID[fieldName];
  if (legacyTestid) {
    return `[data-browsy-item-field="${fieldName}"],[data-testid="${legacyTestid}"]`;
  }
  return `[data-browsy-item-field="${fieldName}"]`;
}

// Resolve item section selector: prefer generic attribute, fall back to legacy class.
async function resolveSectionSelector(page) {
  const count = await page.locator('[data-browsy-item-section]').count();
  return count > 0 ? '[data-browsy-item-section]' : '.track-section';
}

// Fill a text/date input, select, or checkbox within `scope` (Page or Locator).
async function fillField(scope, selector, value, label) {
  const el = scope.locator(selector).first();
  if (await el.count() === 0) {
    throw new Error(`${label}: selector "${selector}" not found`);
  }
  const tagName = await el.evaluate(e => e.tagName.toLowerCase());
  const type    = await el.evaluate(e => (e.type || '').toLowerCase());

  if (tagName === 'select') {
    await el.selectOption(String(value ?? ''));
  } else if (type === 'checkbox') {
    const shouldCheck = Boolean(value);
    if (shouldCheck !== await el.isChecked()) {
      shouldCheck ? await el.check() : await el.uncheck();
    }
  } else {
    await el.fill(String(value ?? ''));
  }
}

// Set a file on a file input within `scope`.
async function uploadField(scope, selector, filePath, label) {
  const el = scope.locator(selector).first();
  if (await el.count() === 0) {
    throw new Error(`${label}: upload selector "${selector}" not found`);
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label}: upload file not found at "${filePath}"`);
  }
  await el.setInputFiles(filePath);
}

// Read back the filled form state for assertions.
// Returns generic structure: globalFields, itemSections, itemSectionCount, plus
// fixture-specific legacy fields (submitClicked, releaseClicked, legalCertChecked).
async function extractFinalState(page) {
  return page.evaluate(() => {
    // Detect section selector
    const genericSections = [...document.querySelectorAll('[data-browsy-item-section]')];
    const legacySections  = [...document.querySelectorAll('.track-section')];
    const sections = genericSections.length > 0 ? genericSections : legacySections;

    // Read global fields by scanning data-browsy-field attributes
    const globalFields = {};
    for (const el of document.querySelectorAll('[data-browsy-field]')) {
      const key = el.getAttribute('data-browsy-field');
      if (el.type === 'checkbox') globalFields[key] = el.checked;
      else globalFields[key] = el.value;
    }

    // Read item sections
    const itemSections = sections.map(sec => {
      const fields = {};
      const browsynodes = sec.querySelectorAll('[data-browsy-item-field]');
      if (browsynodes.length > 0) {
        for (const el of browsynodes) {
          const key = el.getAttribute('data-browsy-item-field');
          if (el.type === 'checkbox') fields[key] = el.checked;
          else fields[key] = el.value;
        }
      } else {
        // Legacy fallback: read data-testid elements
        for (const el of sec.querySelectorAll('[data-testid]')) {
          const key = el.getAttribute('data-testid');
          if (el.type === 'checkbox') fields[key] = el.checked;
          else fields[key] = el.value;
        }
      }
      return fields;
    });

    return {
      pageTitle: document.title,
      globalFields,
      itemSections,
      itemSectionCount: sections.length,
      finalActionClicked: window.lastFinalAction ?? null,
      // Legacy aliases kept for backward compat with album-upload acceptance tests
      submitClicked:    window.lastFinalAction === 'submit',
      releaseClicked:   window.lastFinalAction === 'release',
      legalCertChecked: document.getElementById('legal-cert')?.checked ?? false,
    };
  });
}

// Execute a run plan against a browser fixture or live URL.
//
// Options:
//   runPlan        — { steps } from buildRunPlan() or buildRunPlanFromPackage()
//   fixturePath    — absolute path to an HTML fixture file (used when targetUrl is absent)
//   targetUrl      — live URL to navigate to (takes precedence over fixturePath)
//   manifestBaseDir — directory from which relative file paths are resolved
//   headless       — launch headless (default true)
//   trace          — save Playwright trace beside the fixture (default false)
//   safetyPolicy   — safety policy object (defaults to defaultSafetyPolicy())
//   downloadsDir   — optional directory to save downloaded files; downloads are
//                    always captured in downloadedFiles[] but only persisted when set
//
// Returns:
//   { ok, executedSteps, skippedSteps, checkpoint, finalState, capturedOutputs, downloadedFiles }
//   ok=false also sets .error with the message.
export async function executeRunPlanWithPlaywright({
  runPlan,
  fixturePath,
  targetUrl,
  manifestBaseDir,
  headless = true,
  trace = false,
  safetyPolicy,
  fieldMap,
  downloadsDir = null,
  workflowId = null,
  runId = null,
  callbackUrl = null,
  signals = true,
}) {
  const policy          = safetyPolicy ?? defaultSafetyPolicy();
  const executedSteps   = [];
  const skippedSteps    = [];
  const capturedOutputs = {};
  const downloadedFiles = [];
  let checkpoint  = null;
  let finalState  = null;
  let browser     = null;

  try {
    browser = await chromium.launch({ headless });
    const ctx  = await browser.newContext({ acceptDownloads: true });

    if (trace) {
      await ctx.tracing.start({ screenshots: true, snapshots: true });
    }

    const page = await ctx.newPage();
    const url  = targetUrl ?? pathToFileURL(path.resolve(fixturePath)).href;
    await page.goto(url);

    // Capture downloads — always record metadata; persist bytes only when downloadsDir is set.
    page.on('download', async download => {
      const suggested = (() => { try { return download.suggestedFilename(); } catch { return null; } })();
      const entry = { filename: suggested || 'download', url: (() => { try { return download.url(); } catch { return null; } })() };
      if (downloadsDir) {
        try {
          fs.mkdirSync(downloadsDir, { recursive: true });
          const filename = suggested && /^[A-Za-z0-9._-]+$/.test(suggested)
            ? suggested
            : `download-${Date.now()}.bin`;
          const filePath = path.join(downloadsDir, filename);
          await download.saveAs(filePath);
          entry.path = filePath;
        } catch (err) {
          entry.error = err.message;
        }
      }
      downloadedFiles.push(entry);
    });

    // For live URLs with repeat groups, wait for at least one section to appear before
    // detecting the selector — sections may load asynchronously.
    const hasRepeatSteps = runPlan.steps.some(s => s.type === 'repeat_iteration');
    if (hasRepeatSteps) {
      await page.waitForSelector(
        '[data-browsy-item-section], .track-section',
        { timeout: 10_000 }
      ).catch(() => {}); // graceful: page may have no sections yet on first load
    }

    // Detect section selector once after page load
    let sectionSel = await resolveSectionSelector(page);

    for (const step of runPlan.steps) {
      // ── Global fill ──────────────────────────────────────────────────────────
      if (step.type === 'fill_global') {
        const sel   = globalFieldSelector(step.source, fieldMap);
        const label = `fill_global[${step.source}]`;
        await fillField(page, sel, step.value, label);
        executedSteps.push({ type: step.type, source: step.source, value: step.value });

      // ── Global upload ────────────────────────────────────────────────────────
      } else if (step.type === 'upload_global') {
        const sel      = globalFieldSelector(step.source, fieldMap);
        const filePath = path.resolve(manifestBaseDir, step.value);
        const label    = `upload_global[${step.source}]`;
        await uploadField(page, sel, filePath, label);
        executedSteps.push({
          type: step.type, source: step.source, value: step.value, resolvedPath: filePath,
        });

      // ── Repeat iteration ─────────────────────────────────────────────────────
      } else if (step.type === 'repeat_iteration') {
        const { itemIndex, steps: subSteps } = step;

        for (const sub of subSteps) {
          // ensure_section — verify or create the DOM section for this item
          if (sub.type === 'ensure_section') {
            if (itemIndex === 0 || !sub.repeatAction) {
              // First section pre-exists — verify it is there
              const count = await page.locator(sectionSel).count();
              if (count <= itemIndex) {
                throw new Error(
                  `ensure_section[${itemIndex}]: expected ≥${itemIndex + 1} section(s) matching "${sectionSel}", found ${count}`
                );
              }
              executedSteps.push({ type: sub.type, itemIndex, action: 'verified-exists' });

            } else {
              // Subsequent sections: click the repeatAction to add a new one
              const addSel = sub.repeatAction.selector;
              const addBtn = page.locator(addSel);
              if (await addBtn.count() === 0) {
                throw new Error(
                  `ensure_section[${itemIndex}]: repeatAction selector "${addSel}" not found`
                );
              }
              const countBefore = await page.locator(sectionSel).count();
              const addLabel = sub.repeatAction?.label ?? sub.repeatAction?.selector ?? '';
              await safeClick(addBtn, addLabel, policy);
              await page.waitForFunction(
                ([sel, expected]) => document.querySelectorAll(sel).length >= expected,
                [sectionSel, countBefore + 1],
                { timeout: 5000 }
              );
              // Re-detect section selector after new sections may have been added
              sectionSel = await resolveSectionSelector(page);
              executedSteps.push({
                type: sub.type, itemIndex, action: 'clicked-add', selector: addSel,
              });
            }

          // fill_item — fill a non-file field scoped to this item section
          } else if (sub.type === 'fill_item') {
            const section = page.locator(sectionSel).nth(itemIndex);
            const sel     = itemFieldSelector(sub.fieldName, fieldMap);
            const label   = `fill_item[${itemIndex}].${sub.fieldName}`;
            await fillField(section, sel, sub.value, label);
            executedSteps.push({
              type: sub.type, itemIndex, fieldName: sub.fieldName, value: sub.value,
              fromDefault: sub.fromDefault ?? false,
            });

          // upload_item — set a file on an upload field scoped to this item section
          } else if (sub.type === 'upload_item') {
            const section  = page.locator(sectionSel).nth(itemIndex);
            const sel      = itemFieldSelector(sub.fieldName, fieldMap);
            const filePath = path.resolve(manifestBaseDir, sub.value);
            const label    = `upload_item[${itemIndex}].${sub.fieldName}`;
            await uploadField(section, sel, filePath, label);
            executedSteps.push({
              type: sub.type, itemIndex, fieldName: sub.fieldName, value: sub.value, resolvedPath: filePath,
            });

          } else {
            skippedSteps.push({ type: sub.type, reason: 'unrecognized sub-step type' });
          }
        }

      // ── Click a safe (non-dangerous) action ─────────────────────────────────
      } else if (step.type === 'click_safe_action') {
        const btn = page.locator(step.selector).first();
        if (await btn.count() > 0) {
          await btn.click();
          executedSteps.push({ type: step.type, selector: step.selector, label: step.label });
        } else {
          skippedSteps.push({ type: step.type, selector: step.selector, reason: 'element not found' });
        }

      // ── Capture text content of an output element ────────────────────────────
      } else if (step.type === 'capture_output') {
        const el = page.locator(step.selector).first();
        if (await el.count() > 0) {
          const text = await el.textContent();
          capturedOutputs[step.outputId] = { status: 'captured', value: text?.trim() || null };
          executedSteps.push({ type: step.type, outputId: step.outputId, captured: true });
        } else {
          capturedOutputs[step.outputId] = { status: 'not_found', value: null };
          executedSteps.push({ type: step.type, outputId: step.outputId, captured: false });
        }

      // ── Human checkpoint — always stop here ──────────────────────────────────
      } else if (step.type === 'human_checkpoint') {
        checkpoint = step;
        // Make the hand-off to a human unmistakable: paint the live page and
        // push a "needs input" signal to the terminal / calling app.
        if (signals) {
          await emitNeedsInput({
            reason: step.reason || 'Human review required before the final action.',
            workflowId,
            runId,
            blockedActions: step.blocked || [],
            suggestedAction: 'Review the browser, complete any manual-only actions, then approve the final action.',
            page,
          }, { callbackUrl });
        }
        break;

      } else {
        skippedSteps.push({ type: step.type, reason: 'unrecognized step type' });
      }
    }

    finalState = await extractFinalState(page);

    // Signal completion before tearing down. When we stopped at a human
    // checkpoint the run is "waiting on a human", not done — that case already
    // emitted a needs_input signal above, so only emit done when we ran clean.
    if (signals && !checkpoint) {
      await emitDone({
        status: 'completed',
        workflowId,
        runId,
        filled: executedSteps.length,
        skipped: skippedSteps.length,
        errors: 0,
        capturedOutputs,
        page,
      }, { callbackUrl });
    }

    if (trace) {
      const traceDir = path.dirname(fixturePath);
      await ctx.tracing.stop({ path: path.join(traceDir, 'trace.zip') });
    }

    await browser.close();
    browser = null;

    return { ok: true, executedSteps, skippedSteps, checkpoint, finalState, capturedOutputs, downloadedFiles };

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    return { ok: false, error: err.message, executedSteps, skippedSteps, checkpoint, finalState, capturedOutputs, downloadedFiles };
  }
}
