// Playwright executor for repeat-group run plans.
//
// Consumes a run plan produced by buildRunPlan() or buildRunPlanFromPackage()
// and drives a local fixture (or any browser page) through each step.
// Stops at the human_checkpoint by default — final submit is not automated. The
// only exception is the explicit `autoSubmit` opt-in, which runs the declarative
// fieldMap.postSubmitSteps chain (final submit → mixea upsell → done page →
// capture HyperFollow link), optionally gated behind an out-of-band human confirm.
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
//
// DistroKid shows a SweetAlert2 modal with checkboxes ("Which parts of this
// song were AI-generated?") when you click into the AI disclosure section of
// an upload track. The flow is:
//   1. Trigger: click the gate selector (the inline AI-gate element) — clicking
//      it opens the SweetAlert2 checkbox modal as a side effect.
//   2. Wait for the SweetAlert2 popup to animate in.
//   3. Inside the popup, check the appropriate gate checkbox(es) — the modal
//      requires at least one selection before Save is enabled.
//   4. Click the Save/confirm button (.swal2-confirm) to dismiss the modal.
//
// fieldDef (from fieldMap.fields[fieldName]):
//   selector       — CSS selector for the gate checkboxes (inside the modal)
//   triggerSelector — optional selector to click to open the modal instead of
//                    the gate selector itself
//   saveLabel      — ignored (always uses .swal2-confirm)
// gateValue: "1"=all-AI, "2"=part AI+human, "0"=none (no disclosure needed).
async function handleAiDisclosure(page, fieldDef, gateValue, itemIndex, policy, label) {
  const sub = (s) => substituteIndex(s, itemIndex);

  // DistroKid's AI disclosure is a per-track No/Yes radio (class distroAiGate,
  // value "0"=No / "1"=Yes). Selecting "Yes" opens a SweetAlert2 modal where you
  // pick the recording scope. gateValue: "1"=all-audio AI, "2"=part, "0"/""=none.
  const gate    = String(gateValue ?? '');
  const gateSel = sub(fieldDef.selector || 'input.distroAiGate');
  const popupSel = '.swal2-popup';

  // "No" — declare no AI: select this track's value="0" gate and stop (no modal).
  if (gate === '0' || gate === '') {
    await page.locator(`${gateSel}[value="0"]`).nth(itemIndex).check({ force: true }).catch(() => {});
    return;
  }

  // Step 1 — click THIS track's "Yes" gate radio to open the modal. There is one
  // value="1" radio per track, in DOM order, so .nth(itemIndex) scopes us to the
  // right track. (The previous .first() always hit track 1's "No", so the modal
  // never opened and the disclosure silently stayed on "No".)
  const yesRadio = page.locator(`${gateSel}[value="1"]`).nth(itemIndex);
  if (await yesRadio.count() > 0) {
    await yesRadio.check({ force: true }).catch(() => {});
  } else {
    await page.locator(gateSel).nth(itemIndex).check({ force: true }).catch(() => {});
  }

  // Step 2 — wait for the SweetAlert2 disclosure modal.
  try {
    await page.waitForSelector(popupSel, { state: 'visible', timeout: 4000 });
  } catch {
    return; // No modal (older/inline UI variant) — the gate is set, nothing more.
  }

  // Step 3 — inside the modal, select the recording scope. Per the Figment Factory
  // spec every track is "All of the audio (performed by AI)" = the
  // distroAiRecordingScope checkbox with value "full" ("partial" for gate "2").
  const scopeSel   = sub(fieldDef.scopeSelector || 'input.distroAiRecordingScope');
  const scopeValue = gate === '2' ? 'partial' : (fieldDef.scopeValue || 'full');
  const scopeBox   = page.locator(`${popupSel} ${scopeSel}[value="${scopeValue}"]`).first();
  if (await scopeBox.count() > 0) {
    await scopeBox.check({ force: true }).catch(() => {});
  }

  // Step 4 — click Save (.swal2-confirm) to commit the disclosure.
  const saveSel = `${popupSel} .swal2-confirm`;
  try {
    await page.waitForSelector(saveSel, { state: 'visible', timeout: 2000 });
  } catch {
    return; // Modal disappeared on its own — nothing more to do.
  }
  const saveBtn = page.locator(saveSel).first();
  if (await saveBtn.count() > 0) await safeClick(saveBtn, `${label} save`, policy);

  // Wait for the popup to close before proceeding to the next track.
  await page.waitForSelector(popupSel, { state: 'hidden', timeout: 4000 }).catch(() => {});
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
      try {
        // force: a normal click on some DistroKid checkboxes (e.g.
        // #areyousuretandc) does not flip state, which makes Playwright's
        // check()/uncheck() throw "Clicking the checkbox did not change its
        // state". Forcing skips that post-click assertion.
        shouldCheck ? await el.check({ force: true }) : await el.uncheck({ force: true });
      } catch {
        // Click still didn't take. Set the state directly and fire the events
        // (input/change + onblur validation hooks like removeRedIfAllFilled).
        // The human checkpoint still gates final submit.
        await el.evaluate((node, checked) => {
          node.checked = checked;
          node.dispatchEvent(new Event('input', { bubbles: true }));
          node.dispatchEvent(new Event('change', { bubbles: true }));
          node.dispatchEvent(new Event('blur', { bubbles: true }));
        }, shouldCheck);
      }
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
  leaveBrowserOpen = false,
  // ── End-to-end auto-submit (opt-in only) ──────────────────────────────────
  // autoSubmit: when true, instead of parking at the human_checkpoint the
  //   executor runs fieldMap.postSubmitSteps (click final submit → clear the
  //   mixea upsell → land on the done page → capture the HyperFollow link).
  //   Default false → byte-for-byte the old "never automate final submit".
  // confirmBeforeSubmit: when true, park at the checkpoint and wait for an
  //   out-of-band confirmation (confirmFlagPath appears) before running the
  //   post-submit steps. Used for the live "human reviews, then resume" flow.
  //   If it times out, fall back to the safe leave-browser-open hand-off.
  // isFixture: pick step.fixtureSelector over step.selector (fake test site).
  autoSubmit = false,
  confirmBeforeSubmit = false,
  confirmFlagPath = null,
  confirmTimeoutMs = 30 * 60 * 1000,
  isFixture = false,
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
  let postSubmitCompleted = false;

  // DistroKid uploads artwork and audio to its S3 bucket via XHR. Chrome's
  // Private/Local Network Access checks block these cross-origin uploads in the
  // automated browser ("Permission was denied for this request to access the
  // `local` address space"), which leaves the cover stuck on "Error" and every
  // track at 0%. Disabling those features lets the uploads through. (Unknown
  // feature names are ignored by Chromium, so this is safe across versions.)
  const launchArgs = [
    '--disable-features=BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults,LocalNetworkAccessChecks,LocalNetworkAccessChecksWarningOnly',
  ];

  try {
    let ctx;
    if (userDataDir) {
      // Live mode: reuse the persistent auth profile so DistroKid is logged in.
      persistentCtx = await chromium.launchPersistentContext(userDataDir, {
        headless,
        acceptDownloads: true,
        args: launchArgs,
      });
      ctx = persistentCtx;
    } else {
      browser = await chromium.launch({ headless, args: launchArgs });
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
        // Conditional final acknowledgments (e.g. DistroKid's non-standard
        // capitalization warning) only render after the relevant fields are
        // filled, so they can't be pre-iteration globals. Check any that are now
        // present + unchecked right before handing off to the human.
        for (const ackSel of fieldMap?.acknowledgeIfPresent || []) {
          const boxes = page.locator(ackSel);
          const n = await boxes.count();
          for (let k = 0; k < n; k++) {
            const box = boxes.nth(k);
            const visible = await box.isVisible().catch(() => false);
            const checked = await box.isChecked().catch(() => false);
            if (visible && !checked) {
              await box.check({ force: true }).catch(() => {});
              executedSteps.push({ type: 'acknowledge_if_present', selector: ackSel, index: k });
            }
          }
        }
        checkpoint = step;

        // ── End-to-end auto-submit (opt-in) ───────────────────────────────────
        // Default path: stop here, hand off to a human (final submit is never
        // automated). Only when autoSubmit is explicitly set do we run the
        // post-submit chain (submit → mixea → done → capture HyperFollow).
        const postSubmitSteps = fieldMap?.postSubmitSteps || [];
        if (autoSubmit && postSubmitSteps.length) {
          let proceed = true;
          if (confirmBeforeSubmit) {
            // Park on the filled page and wait for an out-of-band human confirm
            // (the confirmFlagPath file appears). Bounded so a forgotten run
            // doesn't hang forever; on timeout we fall through to the safe
            // leave-browser-open hand-off below.
            proceed = await waitForConfirmFlag(confirmFlagPath, confirmTimeoutMs);
            executedSteps.push({ type: 'await_submit_confirmation', confirmed: proceed, flagPath: confirmFlagPath });
          }
          if (proceed) {
            await runPostSubmitSteps({
              page, steps: postSubmitSteps, isFixture,
              capturedOutputs, executedSteps, skippedSteps,
            });
            postSubmitCompleted = true;
          }
        }
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

    // Live human handoff: when asked to leave the browser open AND we stopped at a
    // human checkpoint WITHOUT auto-submitting, hand the live, filled page to the
    // person (review + click final submit) instead of tearing it down. Detach our
    // references so cleanup does not close it; it stays open under the launching
    // (server) process. When post-submit ran to completion we are fully done, so
    // we fall through and close normally.
    if (leaveBrowserOpen && checkpoint && !postSubmitCompleted) {
      persistentCtx = null;
      browser = null;
      return { ok: true, executedSteps, skippedSteps, checkpoint, finalState, capturedOutputs, downloadedFiles, browserLeftOpen: true, postSubmitCompleted };
    }

    if (persistentCtx) { await persistentCtx.close(); persistentCtx = null; }
    if (browser)       { await browser.close(); browser = null; }

    return { ok: true, executedSteps, skippedSteps, checkpoint, finalState, capturedOutputs, downloadedFiles, browserLeftOpen: false, postSubmitCompleted };

  } catch (err) {
    if (persistentCtx) await persistentCtx.close().catch(() => {});
    if (browser)       await browser.close().catch(() => {});
    return { ok: false, error: err.message, executedSteps, skippedSteps, checkpoint, finalState, capturedOutputs, downloadedFiles, postSubmitCompleted };
  }
}

// ── Post-submit step interpreter ───────────────────────────────────────────────
// Runs the small, declarative fieldMap.postSubmitSteps program on the SAME page
// the run filled, after the human_checkpoint. Supported step types:
//   click      — click an element (e.g. the final Submit/Continue button)
//   check      — tick a radio/checkbox (e.g. "Use my originals"), JS fallback
//   waitForUrl — wait until the page URL contains step.match (mixea → done)
//   capture    — read step.attr (default href) or text into capturedOutputs
// Each step resolves its selector from step.fixtureSelector when isFixture (the
// fake test site) else step.selector (live DistroKid). Steps may be marked
// optional:true to skip-without-failing when the element is absent.
async function runPostSubmitSteps({ page, steps, isFixture, capturedOutputs, executedSteps, skippedSteps }) {
  const sel = step => (isFixture && step.fixtureSelector ? step.fixtureSelector : step.selector);
  for (const step of steps) {
    // appliesTo scopes a step to one surface: 'fixture' (fake test site only) or
    // 'live' (real DistroKid only). Undefined runs on both. Lets the fake site and
    // the real DOM diverge (e.g. live combines "use originals" + continue into one
    // button, so the fixture-only radio-tick is skipped on live).
    if (step.appliesTo === 'fixture' && !isFixture) { skippedSteps.push({ type: `post_submit_${step.type}`, reason: 'fixture-only step skipped on live' }); continue; }
    if (step.appliesTo === 'live' && isFixture) { skippedSteps.push({ type: `post_submit_${step.type}`, reason: 'live-only step skipped on fixture' }); continue; }
    const selector = sel(step);
    try {
      if (step.type === 'waitForUrl') {
        await page.waitForURL(url => String(url).includes(step.match), { timeout: step.timeoutMs || 120000 });
        executedSteps.push({ type: 'post_submit_waitForUrl', match: step.match, url: page.url() });
        continue;
      }

      // Dismiss the cookie banner if it reappeared between navigations — it can
      // intercept clicks on the post-submit pages too.
      await dismissCookieBanner(page).catch(() => {});

      const loc = page.locator(selector).first();
      const present = await loc.count().catch(() => 0);
      if (!present) {
        if (step.optional) { skippedSteps.push({ type: `post_submit_${step.type}`, selector, reason: 'optional element absent' }); continue; }
        throw new Error(`post-submit ${step.type} target not found: ${selector}`);
      }

      if (step.type === 'click') {
        await loc.click({ timeout: step.timeoutMs || 30000 });
        executedSteps.push({ type: 'post_submit_click', selector, label: step.label || null });
      } else if (step.type === 'check') {
        // DistroKid radios/checkboxes are sometimes visually replaced; force-check
        // and fall back to a dispatched JS click if the native check is blocked.
        await loc.check({ force: true, timeout: step.timeoutMs || 30000 }).catch(async () => {
          await loc.evaluate(el => { el.checked = true; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); });
        });
        executedSteps.push({ type: 'post_submit_check', selector, label: step.label || null });
      } else if (step.type === 'capture') {
        const value = step.attr
          ? await loc.getAttribute(step.attr)
          : (await loc.textContent())?.trim() || null;
        capturedOutputs[step.outputId] = { status: value ? 'captured' : 'empty', value: value || null, selector, required: step.required === true };
        executedSteps.push({ type: 'post_submit_capture', outputId: step.outputId, captured: !!value });
      } else {
        skippedSteps.push({ type: `post_submit_${step.type}`, reason: 'unrecognized post-submit step type' });
      }
    } catch (err) {
      if (step.optional) { skippedSteps.push({ type: `post_submit_${step.type}`, selector, reason: err.message }); continue; }
      throw new Error(`post-submit step "${step.label || step.type}" failed: ${err.message}`);
    }
  }
}

// Poll for the out-of-band confirmation flag file. Returns true once it appears,
// false if confirmTimeoutMs elapses first. A null path means "no confirmation
// channel configured" → never auto-proceed (caller falls back to hand-off).
async function waitForConfirmFlag(flagPath, confirmTimeoutMs) {
  if (!flagPath) return false;
  const deadline = Date.now() + (confirmTimeoutMs || 0);
  while (Date.now() < deadline) {
    if (fs.existsSync(flagPath)) return true;
    await new Promise(r => setTimeout(r, 2000));
  }
  return fs.existsSync(flagPath);
}
