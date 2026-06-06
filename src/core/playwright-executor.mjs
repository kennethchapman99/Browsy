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

// Substitute 1-based ({n}) and 0-based ({i}) item indices into a selector template.
function substituteIndex(selector, itemIndex) {
  if (typeof selector !== 'string') return selector;
  return selector
    .replace(/\{n\}/g, String(itemIndex + 1))
    .replace(/\{i\}/g, String(itemIndex));
}

function itemFieldSelector(fieldName, fieldMap, itemIndex = 0) {
  if (fieldMap?.fields?.[fieldName]?.selector) {
    return substituteIndex(fieldMap.fields[fieldName].selector, itemIndex);
  }
  const legacyTestid = ITEM_TESTID[fieldName];
  if (legacyTestid) {
    return `[data-browsy-item-field="${fieldName}"],[data-testid="${legacyTestid}"]`;
  }
  return `[data-browsy-item-field="${fieldName}"]`;
}

// True when any item-field selector uses an index template ({n}/{i}). Such
// selectors are self-indexing (e.g. live DistroKid's input.uploadFileTitle.track_3),
// so per-item fields run against the whole page rather than a scoped DOM section.
function usesIndexedSelectors(fieldMap) {
  const fields = fieldMap?.fields || {};
  return Object.values(fields).some(
    f => f?.item && typeof f.selector === 'string' && /\{[ni]\}/.test(f.selector)
  );
}

// Drive DistroKid's per-track AI-disclosure modal sequence.
// Config (from fieldMap.fields[fieldName]): selector (gate radios), scopeSelector,
// scopeValue, confirmLabels[], saveLabel, optional triggerSelector to open the modal.
// gateValue: "1"=all-AI, "2"=part AI+human, "0"=none.
async function handleAiDisclosure(page, fieldDef, gateValue, itemIndex, policy, label) {
  const sub = (s) => substituteIndex(s, itemIndex);

  if (fieldDef.triggerSelector) {
    const trig = page.locator(sub(fieldDef.triggerSelector)).first();
    if (await trig.count() > 0) await safeClick(trig, `${label} trigger`, policy);
  }

  const gateSel = sub(fieldDef.selector || 'input.distroAiGate');
  const byValue = page.locator(`${gateSel}[value="${gateValue}"]`).first();
  if (await byValue.count() > 0) {
    await byValue.check();
  } else {
    const all = page.locator(gateSel);
    const n = await all.count();
    if (n === 0) throw new Error(`${label}: AI gate selector "${gateSel}" not found`);
    await all.nth(Math.min(Number(gateValue) || 0, n - 1)).check();
  }

  // The follow-up dialogs are SweetAlert2 modals. Scope confirm clicks to the
  // visible .swal2-popup and click its primary confirm button (.swal2-confirm),
  // not arbitrary page buttons — otherwise a label like "OK" can match an
  // unrelated overlay (e.g. the Osano cookie banner).
  for (let i = 0; i < (fieldDef.confirmLabels || []).length; i++) {
    const confirm = page.locator('.swal2-popup .swal2-confirm:visible').first();
    if (await confirm.count() > 0) {
      await safeClick(confirm, `${label} confirm[${i}]`, policy);
      await page.waitForTimeout(300);
    }
  }

  if (fieldDef.scopeSelector && fieldDef.scopeValue) {
    const scopeSel = sub(fieldDef.scopeSelector);
    const scopeByVal = page.locator(`${scopeSel}[value="${fieldDef.scopeValue}"]`).first();
    if (await scopeByVal.count() > 0) await scopeByVal.check().catch(() => {});
    else {
      const anyScope = page.locator(scopeSel).first();
      if (await anyScope.count() > 0) await anyScope.check().catch(() => {});
    }
  }

  const saveBtn = page.locator('.swal2-popup .swal2-confirm:visible').first();
  if (await saveBtn.count() > 0) await safeClick(saveBtn, `${label} save`, policy);
}

// Dismiss the Osano cookie-consent banner if present — it overlays the page and
// intercepts clicks/visibility for elements beneath it.
async function dismissCookieBanner(page) {
  const accept = page.locator('.osano-cm-accept-all, .osano-cm-accept, .osano-cm-save').first();
  try {
    if (await accept.count() > 0 && await accept.isVisible()) {
      await accept.click({ timeout: 3000 });
      await page.waitForTimeout(300);
    }
  } catch { /* non-fatal */ }
}

// Resolve item section selector: prefer generic attribute, fall back to legacy class.
async function resolveSectionSelector(page) {
  const count = await page.locator('[data-browsy-item-section]').count();
  return count > 0 ? '[data-browsy-item-section]' : '.track-section';
}

// Select a <select> option, tolerating label punctuation/whitespace differences.
// Tries Playwright's exact value/label match first, then falls back to a
// normalized comparison against the actual option list (e.g. payload
// "Hip-Hop/Rap" vs DistroKid option "Hip Hop/Rap").
async function selectOptionResilient(el, value, label) {
  const target = String(value ?? '');
  const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const wanted = norm(target);

  // Read options via evaluate — works even when the native <select> is hidden
  // behind a custom widget (e.g. DistroKid's data-dk-searchable-select).
  const options = await el.evaluate(sel =>
    [...sel.options].map(o => ({ value: o.value, text: o.textContent || '' }))
  );
  const match = options.find(o => o.value === target || o.text.trim() === target)
    || options.find(o => norm(o.text) === wanted || norm(o.value) === wanted)
    || (wanted.length > 0 ? options.find(o => norm(o.text).includes(wanted)) : null);
  if (!match) {
    throw new Error(`${label}: no <option> matched "${target}" (options: ${options.map(o => o.text.trim()).filter(Boolean).join(', ')})`);
  }

  try {
    await el.selectOption(match.value, { timeout: 3000 });
    return;
  } catch {
    // Native select is hidden behind a custom widget — set the value directly
    // and fire the events the widget/validation listen for.
    await el.evaluate((node, v) => {
      node.value = v;
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
      node.dispatchEvent(new Event('blur', { bubbles: true }));
    }, match.value);
  }
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
    await selectOptionResilient(el, value, label);
  } else if (type === 'checkbox') {
    const shouldCheck = Boolean(value);
    if (shouldCheck !== await el.isChecked()) {
      shouldCheck ? await el.check() : await el.uncheck();
    }
  } else {
    const text = String(value ?? '');
    try {
      await el.fill(text, { timeout: 5000 });
    } catch {
      // Input exists but isn't visible/editable (e.g. a collapsed DistroKid
      // credit row). Set the value directly and fire the events validation and
      // onblur handlers listen for. The human checkpoint still gates submit.
      await el.evaluate((node, v) => {
        node.value = v;
        node.dispatchEvent(new Event('input', { bubbles: true }));
        node.dispatchEvent(new Event('change', { bubbles: true }));
        node.dispatchEvent(new Event('blur', { bubbles: true }));
      }, text);
    }
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
  userDataDir = null,
  downloadsDir = null,
}) {
  const policy          = safetyPolicy ?? defaultSafetyPolicy();
  const executedSteps   = [];
  const skippedSteps    = [];
  const capturedOutputs = {};
  const downloadedFiles = [];
  const indexedMode     = usesIndexedSelectors(fieldMap);
  let checkpoint  = null;
  let finalState  = null;
  let browser     = null;
  let persistentCtx = null;

  try {
    let ctx;
    if (userDataDir) {
      // Live mode: reuse the persistent auth profile so DistroKid is logged in.
      persistentCtx = await chromium.launchPersistentContext(userDataDir, {
        headless,
        acceptDownloads: true,
      });
      ctx = persistentCtx;
    } else {
      browser = await chromium.launch({ headless });
      ctx = await browser.newContext({ acceptDownloads: true });
    }

    if (trace) {
      await ctx.tracing.start({ screenshots: true, snapshots: true });
    }

    const page = await ctx.newPage();
    const url  = targetUrl ?? pathToFileURL(path.resolve(fixturePath)).href;
    await page.goto(url);
    await dismissCookieBanner(page);

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
    if (hasRepeatSteps && !indexedMode) {
      await page.waitForSelector(
        '[data-browsy-item-section], .track-section',
        { timeout: 10_000 }
      ).catch(() => {}); // graceful: page may have no sections yet on first load
    }

    // Detect section selector once after page load (skipped in indexed mode,
    // where item fields self-index via {n}/{i} templated selectors).
    let sectionSel = indexedMode ? null : await resolveSectionSelector(page);

    for (const step of runPlan.steps) {
      // ── Global fill ──────────────────────────────────────────────────────────
      if (step.type === 'fill_global') {
        const fieldName = step.source.split('.').pop();
        const isRequired = fieldMap?.fields?.[fieldName]?.required !== false;
        const sel   = globalFieldSelector(step.source, fieldMap);
        const label = `fill_global[${step.source}]`;
        if (!isRequired && await page.locator(sel).count() === 0) {
          skippedSteps.push({ type: step.type, source: step.source, reason: 'optional field not found on page' });
        } else {
          await fillField(page, sel, step.value, label);
          executedSteps.push({ type: step.type, source: step.source, value: step.value });
        }

      // ── Global upload ────────────────────────────────────────────────────────
      } else if (step.type === 'upload_global') {
        const fieldName = step.source.split('.').pop();
        const isRequired = fieldMap?.fields?.[fieldName]?.required !== false;
        const sel      = globalFieldSelector(step.source, fieldMap);
        const filePath = path.resolve(manifestBaseDir || '.', step.value);
        const label    = `upload_global[${step.source}]`;
        if (!isRequired && await page.locator(sel).count() === 0) {
          skippedSteps.push({ type: step.type, source: step.source, reason: 'optional field not found on page' });
        } else {
          await uploadField(page, sel, filePath, label);
          executedSteps.push({
            type: step.type, source: step.source, value: step.value, resolvedPath: filePath,
          });
        }

      // ── Repeat iteration ─────────────────────────────────────────────────────
      } else if (step.type === 'repeat_iteration') {
        const { itemIndex, steps: subSteps } = step;

        for (const sub of subSteps) {
          // ensure_section — verify or create the DOM section for this item
          if (sub.type === 'ensure_section') {
            if (indexedMode) {
              // Indexed mode: live page has no section markers; per-item fields
              // target index-templated selectors directly. Nothing to create.
              executedSteps.push({ type: sub.type, itemIndex, action: 'indexed-noop' });

            } else if (itemIndex === 0 || !sub.repeatAction) {
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
            const fieldDef = fieldMap?.fields?.[sub.fieldName] || {};
            const label    = `fill_item[${itemIndex}].${sub.fieldName}`;

            if (fieldDef.kind === 'ai_disclosure') {
              // Special: drive DistroKid's per-track AI-disclosure modal sequence.
              // Non-fatal: AI disclosure is a sensitive, human-reviewed field, so
              // if the modal flow can't be driven we record it for the human
              // checkpoint rather than failing the whole run.
              try {
                await handleAiDisclosure(page, fieldDef, sub.value, itemIndex, policy, label);
                executedSteps.push({
                  type: sub.type, itemIndex, fieldName: sub.fieldName, value: sub.value,
                  kind: 'ai_disclosure',
                });
              } catch (aiErr) {
                skippedSteps.push({
                  type: sub.type, itemIndex, fieldName: sub.fieldName,
                  kind: 'ai_disclosure', reason: `ai_disclosure not driven: ${aiErr.message}`,
                });
              }
            } else {
              const scope = indexedMode ? page : page.locator(sectionSel).nth(itemIndex);
              const sel   = itemFieldSelector(sub.fieldName, fieldMap, itemIndex);
              await fillField(scope, sel, sub.value, label);
              executedSteps.push({
                type: sub.type, itemIndex, fieldName: sub.fieldName, value: sub.value,
                fromDefault: sub.fromDefault ?? false,
              });
            }

          // upload_item — set a file on an upload field scoped to this item section
          } else if (sub.type === 'upload_item') {
            const scope    = indexedMode ? page : page.locator(sectionSel).nth(itemIndex);
            const sel      = itemFieldSelector(sub.fieldName, fieldMap, itemIndex);
            const filePath = path.resolve(manifestBaseDir, sub.value);
            const label    = `upload_item[${itemIndex}].${sub.fieldName}`;
            await uploadField(scope, sel, filePath, label);
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
        break;

      } else {
        skippedSteps.push({ type: step.type, reason: 'unrecognized step type' });
      }
    }

    finalState = await extractFinalState(page);

    if (trace) {
      const traceDir = path.dirname(fixturePath);
      await ctx.tracing.stop({ path: path.join(traceDir, 'trace.zip') });
    }

    if (persistentCtx) { await persistentCtx.close(); persistentCtx = null; }
    if (browser)       { await browser.close(); browser = null; }

    return { ok: true, executedSteps, skippedSteps, checkpoint, finalState, capturedOutputs, downloadedFiles };

  } catch (err) {
    if (persistentCtx) await persistentCtx.close().catch(() => {});
    if (browser)       await browser.close().catch(() => {});
    return { ok: false, error: err.message, executedSteps, skippedSteps, checkpoint, finalState, capturedOutputs, downloadedFiles };
  }
}
