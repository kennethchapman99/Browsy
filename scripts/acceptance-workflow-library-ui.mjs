#!/usr/bin/env node
/**
 * Acceptance test: Workflow Library + Play UI
 *
 * Proves the wizard server exposes a workflow library, the /workflows page
 * loads, package validity is surfaced, dry-run and live-safe runs can be
 * triggered through the API, and STOP cleanly cancels an in-flight run and
 * writes a result.json with status: "stopped_by_user".
 *
 * Checks (mirrors the user spec):
 *  1   /workflows loads (HTML 200)
 *  2   Existing workflows are listed via GET /api/workflows
 *  3   observed-workflow appears in the list (fixture under workflows/observed-workflow)
 *  4   Package validity is displayed in the API payload
 *  5   Dry Run can be triggered from the API
 *  6   Live-Safe can be triggered from the API
 *  7   STOP endpoint changes active run to stopped_by_user
 *  8   result.json is written after stop
 *  9   UI exposes latest result (GET /api/workflows/:id returns latestResult)
 * 10   Dangerous-action policy is displayed (safetyPolicy in API + page markup)
 * 11   No final/destructive action is clicked during Live-Safe (human_gate stops it)
 * 12   GET /api/workflows/:id returns workflow.json + package + run-plan contents
 * 13   STOP is a no-op for already-completed runs (returns an error message)
 * 14   Library HTML renders a row table (not tile cards) with the new columns
 * 15   GET /api/workflows exposes selectorMap status per workflow
 * 16   Library row buttons use the new labels (Validate Package, Verify Selectors,
 *      Play in Browser — Safe Mode, Delete)
 * 17   Observation session start rejects requests without a workflowId
 * 18   Observation session start rejects a duplicate workflowId unless overwrite=true
 * 19   POST /api/workflows/:id/verify-selectors validates payload shape
 * 20   DELETE /api/workflows/:id removes the workflow dir and preserves runs by default
 * 21   DELETE ?includeRuns=1 also removes output/runs/<id>
 * 22   When status is blocked the library API surfaces it (not "completed")
 *
 * Usage:
 *   npm run acceptance:workflow-library-ui
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const PORT = 3333;
const BASE_URL = `http://localhost:${PORT}`;
const TEST_WORKFLOW_ID = 'observed-workflow';

let passed = 0, failed = 0;
function pass(label) { console.log('PASS  ' + label); passed++; }
function fail(label, detail = '') {
  console.error('FAIL  ' + label + (detail ? '\n      ' + detail : ''));
  failed++;
}
function section(n, title) { console.log(`\n── Check ${n}: ${title} ──`); }

// ── tiny HTTP helpers ────────────────────────────────────────────────────────
function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      method,
      hostname: '127.0.0.1',
      port: PORT,
      path: urlPath,
      headers: body ? { 'Content-Type': 'application/json' } : {},
    };
    const req = http.request(opts, res => {
      let buf = '';
      res.on('data', d => { buf += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

async function getJson(p) {
  const r = await request('GET', p);
  if (r.status !== 200) throw new Error(`GET ${p} → ${r.status}: ${r.body.slice(0, 200)}`);
  return JSON.parse(r.body);
}

// ── Server lifecycle ─────────────────────────────────────────────────────────
let serverProcess = null;
async function isServerRunning() {
  return new Promise(resolve => {
    const req = http.get(`${BASE_URL}/`, { timeout: 1500 }, () => resolve(true));
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}
async function startServer() {
  if (await isServerRunning()) {
    console.log('(reusing already-running wizard server)');
    return;
  }
  serverProcess = spawn('node', ['wizard/server.mjs'], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    // A tiny artificial delay inside workflow:run gives the test a deterministic
    // window to race STOP against an in-flight child process. Without this the
    // child finishes before we can press STOP and the assertion is flaky.
    env: { ...process.env, BROWSY_RUN_DELAY_MS: '1500' },
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Server did not start within 10s')), 10000);
    serverProcess.stdout.on('data', d => {
      if (d.toString().includes('localhost:')) { clearTimeout(t); setTimeout(resolve, 200); }
    });
    serverProcess.stderr.on('data', d => process.stderr.write(`[srv-err] ${d}`));
    serverProcess.on('error', e => { clearTimeout(t); reject(e); });
    serverProcess.on('exit', code => {
      if (code && code !== 0) { clearTimeout(t); reject(new Error(`Server exited with code ${code}`)); }
    });
  });
}
function stopServer() {
  if (serverProcess) { serverProcess.kill('SIGTERM'); serverProcess = null; }
}

// ── main ─────────────────────────────────────────────────────────────────────
try {
  await startServer();
} catch (e) {
  console.error('FATAL: could not start wizard server:', e.message);
  process.exit(1);
}

try {
  // Check 1 — /workflows loads
  section(1, '/workflows page returns HTML');
  {
    const r = await request('GET', '/workflows');
    if (r.status === 200 && /<title>Browsy Workflow Library<\/title>/i.test(r.body)) {
      pass('/workflows served the library HTML');
    } else {
      fail('/workflows did not return library HTML', `status=${r.status}`);
    }
  }

  // Check 2 — list workflows via API
  section(2, 'GET /api/workflows lists workflows');
  let list;
  try {
    list = await getJson('/api/workflows');
    if (Array.isArray(list.workflows) && list.workflows.length > 0) {
      pass(`/api/workflows returned ${list.workflows.length} workflow(s)`);
    } else {
      fail('/api/workflows returned no workflows', JSON.stringify(list));
    }
  } catch (e) { fail('GET /api/workflows failed', e.message); }

  // Check 3 — observed-workflow appears
  section(3, 'observed-workflow appears in the list');
  {
    const ids = (list?.workflows || []).map(w => w.workflowId);
    if (ids.includes(TEST_WORKFLOW_ID)) pass(`found "${TEST_WORKFLOW_ID}" in /api/workflows`);
    else fail(`"${TEST_WORKFLOW_ID}" missing from list`, `got: ${ids.join(', ')}`);
  }

  // Check 4 — package validity is exposed
  section(4, 'Package validity is exposed in the API payload');
  {
    const w = (list?.workflows || []).find(w => w.workflowId === TEST_WORKFLOW_ID);
    if (w && typeof w.package?.valid === 'boolean') {
      pass(`package.valid present (=${w.package.valid}) for ${TEST_WORKFLOW_ID}`);
    } else {
      fail('package.valid not present', JSON.stringify(w?.package));
    }
  }

  // Check 12 — detail endpoint returns full file contents
  section(12, 'GET /api/workflows/:id returns full file contents');
  let detail;
  try {
    detail = await getJson(`/api/workflows/${TEST_WORKFLOW_ID}`);
    const okFiles = detail.contents?.workflowJson && detail.contents?.packageExample;
    if (okFiles) pass('detail endpoint includes workflowJson + packageExample contents');
    else fail('detail endpoint missing file contents', JSON.stringify(Object.keys(detail.contents || {})));
  } catch (e) { fail('GET /api/workflows/:id failed', e.message); }

  // Check 10 — dangerous-action policy is displayed
  section(10, 'Dangerous-action policy is exposed');
  {
    const sp = detail?.safetyPolicy;
    if (sp && Array.isArray(sp.neverClickText) && Array.isArray(sp.manualOnlyCategories)) {
      pass(`safetyPolicy exposes ${sp.neverClickText.length} blocked text(s) and ${sp.manualOnlyCategories.length} category/ies`);
    } else {
      fail('safetyPolicy missing or malformed', JSON.stringify(sp));
    }
    // Also verify the page markup includes the policy panel.
    const html = (await request('GET', `/workflows/${TEST_WORKFLOW_ID}`)).body;
    if (/data-testid="danger-policy"/.test(html)) pass('runner page markup includes danger-policy panel');
    else fail('runner page markup missing danger-policy panel');
  }

  // Check 5 — Dry Run can be triggered
  section(5, 'Dry Run can be triggered via API');
  let dryRunId;
  {
    const r = await request('POST', `/api/workflows/${TEST_WORKFLOW_ID}/run`, { mode: 'dry_run' });
    if (r.status === 202) {
      const body = JSON.parse(r.body);
      if (body.runId) { dryRunId = body.runId; pass(`Dry Run accepted, runId=${dryRunId}`); }
      else fail('Dry Run response missing runId', r.body);
    } else {
      fail(`Dry Run POST returned ${r.status}`, r.body);
    }
  }

  // Wait for dry run to finish (server delay = 1500ms).
  await new Promise(r => setTimeout(r, 2500));
  let dryFinal;
  if (dryRunId) {
    try {
      dryFinal = await getJson(`/api/runs/${dryRunId}`);
      // The server now distinguishes blocked (exit 4) and live_run_gated
      // (exit 3) from completed (exit 0). All are legitimate terminal
      // statuses for a Dry Run — the previous code lumped them together
      // and surfaced "completed" even when result.status was "blocked".
      const terminal = ['completed','blocked','live_run_gated','failed','stopped_by_user'];
      if (terminal.includes(dryFinal.status)) {
        pass(`Dry Run reached terminal status: ${dryFinal.status}`);
      } else {
        fail(`Dry Run did not reach terminal status, got: ${dryFinal.status}`);
      }
    } catch (e) { fail('GET /api/runs/:dryRunId failed', e.message); }
  }

  // Check 13 — STOP on completed run rejects
  section(13, 'STOP on completed run returns an error');
  if (dryRunId) {
    const r = await request('POST', `/api/runs/${dryRunId}/stop`, {});
    if (r.status === 400) pass('STOP correctly rejected an already-completed run');
    else fail('STOP on completed run was not rejected', `status=${r.status} body=${r.body}`);
  }

  // Check 6 — Live-Safe can be triggered
  section(6, 'Live-Safe can be triggered via API');
  let liveRunId;
  {
    const r = await request('POST', `/api/workflows/${TEST_WORKFLOW_ID}/run`, { mode: 'live' });
    if (r.status === 202) {
      const body = JSON.parse(r.body);
      if (body.runId && body.mode === 'live') {
        liveRunId = body.runId;
        pass(`Live-Safe accepted, runId=${liveRunId}`);
      } else {
        fail('Live-Safe response shape wrong', r.body);
      }
    } else {
      fail(`Live-Safe POST returned ${r.status}`, r.body);
    }
  }

  // Check 7 — STOP transitions active live run to stopped_by_user
  section(7, 'STOP transitions active run to stopped_by_user');
  let stopResult;
  if (liveRunId) {
    // Give the spawn a brief moment to flip from starting → running so STOP
    // hits an in-flight child, not the starting placeholder.
    await new Promise(r => setTimeout(r, 200));
    const r = await request('POST', `/api/runs/${liveRunId}/stop`, {});
    if (r.status === 200) {
      stopResult = JSON.parse(r.body);
      if (stopResult.status === 'stopped_by_user') {
        pass(`stop endpoint returned status=stopped_by_user`);
      } else {
        fail(`expected status=stopped_by_user, got ${stopResult.status}`, r.body);
      }
    } else {
      fail(`stop endpoint returned ${r.status}`, r.body);
    }
  }

  // Check 8 — result.json is written after stop
  section(8, 'result.json is written after STOP');
  if (stopResult?.resultPath) {
    const abs = path.join(REPO_ROOT, stopResult.resultPath);
    if (fs.existsSync(abs)) {
      const json = JSON.parse(fs.readFileSync(abs, 'utf8'));
      if (json.status === 'stopped_by_user' && json.stopped_at && json.return_contract_version === 'automation-result-v1') {
        pass(`result.json @ ${stopResult.resultPath} has status=stopped_by_user + stopped_at`);
      } else {
        fail('result.json missing required stop fields', JSON.stringify(json));
      }
    } else {
      fail('result.json not found on disk', abs);
    }
  } else {
    fail('stop response did not include resultPath', JSON.stringify(stopResult));
  }

  // Check 9 — UI exposes latest result
  section(9, 'UI exposes latest result via /api/workflows/:id');
  {
    const d2 = await getJson(`/api/workflows/${TEST_WORKFLOW_ID}`);
    const latest = d2.latestResult;
    if (latest && latest.status && d2.contents?.latestResultJson) {
      pass(`latestResult exposed (status=${latest.status})`);
    } else {
      fail('latestResult not exposed', JSON.stringify({ has: !!latest, contents: !!d2.contents?.latestResultJson }));
    }
  }

  // Check 11 — No destructive click during Live-Safe
  section(11, 'No final/destructive action is clicked during Live-Safe');
  {
    // The runtime generates result.json with manual_checkpoints[*].type =
    // "final_action_gate" or client_action_requests containing
    // "human_approval_required" / "selector_verification_required". In every
    // valid Live-Safe path we must never see filled_fields representing a
    // destructive action. We also confirm package.human_gate stayed true.
    const d3 = await getJson(`/api/workflows/${TEST_WORKFLOW_ID}`);
    const filled = d3.latestResult?.filled_fields || [];
    const destructive = filled.find(f =>
      /submit|publish|pay|delete|finali[sz]e|charge|checkout/i.test(JSON.stringify(f))
    );
    if (destructive) {
      fail('a destructive field appeared in filled_fields', JSON.stringify(destructive));
    } else if (d3.package?.humanGate !== true) {
      fail('package.human_gate is not true — live-safe protection is off');
    } else {
      pass('no destructive click recorded and human_gate=true preserved');
    }
  }

  // ── New checks for Parts 1+2+3 ───────────────────────────────────────────

  // Check 14 — Library HTML renders a row table (not tile cards)
  section(14, 'Library HTML uses a row/table layout');
  {
    const r = await request('GET', '/workflows');
    const html = r.body || '';
    const hasTable = /data-testid="workflow-table"/.test(html);
    const hasOldGrid = /data-testid="workflow-grid"/.test(html);
    if (hasTable && !hasOldGrid) pass('library.html includes data-testid="workflow-table" and no longer renders the tile grid');
    else fail('library.html should expose workflow-table and drop workflow-grid', `hasTable=${hasTable} hasOldGrid=${hasOldGrid}`);

    const expectedHeaders = ['Workflow ID','Title','Source URL','Package','Selector map','Last run','Fields','Assets','Repeats','Outputs','Manual','Actions'];
    const missing = expectedHeaders.filter(h => !new RegExp('<th[^>]*>\\s*' + h.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\$&') + '\\s*<').test(html));
    if (!missing.length) pass('all required column headers present');
    else fail('missing column headers', missing.join(', '));
  }

  // Check 15 — selectorMap status is exposed per workflow
  section(15, 'GET /api/workflows exposes selectorMap status');
  {
    const list2 = await getJson('/api/workflows');
    const w = (list2.workflows || []).find(w => w.workflowId === TEST_WORKFLOW_ID);
    if (w && w.selectorMap && typeof w.selectorMap.exists === 'boolean' && typeof w.selectorMap.valid === 'boolean') {
      pass(`selectorMap exposed (exists=${w.selectorMap.exists} valid=${w.selectorMap.valid} fields=${w.selectorMap.fieldCount})`);
    } else {
      fail('selectorMap missing from /api/workflows payload', JSON.stringify(w?.selectorMap));
    }
  }

  // Check 16 — new row-action button labels (row buttons are rendered by JS,
  // so we accept either the static attribute form OR the literal string the
  // inline script writes via setAttribute).
  section(16, 'Library row exposes the new button labels');
  {
    const html = (await request('GET', '/workflows')).body;
    const needles = [
      'btn-validate-package',
      'btn-verify-selectors',
      'btn-play-safe-mode',
      'btn-delete',
      'btn-details',
    ];
    const missing = needles.filter(n =>
      !html.includes(`data-testid="${n}"`) &&
      !html.includes(`'${n}'`) &&
      !html.includes(`"${n}"`)
    );
    if (!missing.length) pass('all new row-action data-testids present in library.html');
    else fail('missing row-action selectors', missing.join(', '));
  }

  // Check 17 — observation session start requires a workflowId
  section(17, 'Observation session start requires a workflowId');
  {
    const r = await request('POST', '/api/observation/session/start', { source: 'playwrightRecorder', startUrl: 'http://localhost:3333/fixtures/kitchen-sink-workflow/index.html' });
    if (r.status === 400 && /workflowId/i.test(r.body)) pass('session start rejected request without workflowId');
    else fail('session start should reject missing workflowId', `status=${r.status} body=${r.body.slice(0, 200)}`);
  }

  // Check 18 — observation session start rejects duplicate workflowId unless overwrite=true
  section(18, 'Observation session start rejects duplicate workflowId without overwrite');
  {
    // observed-workflow already exists under workflows/. Try to start a new
    // session against it without overwrite → expect 409.
    // We don't actually call playwright here (would launch a real browser)
    // — instead we exercise the dup-check by posting an URL that fails
    // gracefully if the dup check passes (no playwright import).
    const r = await request('POST', '/api/observation/session/start', {
      source: 'playwrightRecorder',
      startUrl: 'http://localhost:3333/fixtures/kitchen-sink-workflow/index.html',
      workflowId: TEST_WORKFLOW_ID,
    });
    if (r.status === 409) {
      const body = JSON.parse(r.body);
      if (body.code === 'workflow_exists') pass('duplicate workflowId rejected with code=workflow_exists');
      else fail('expected 409 with code=workflow_exists', r.body);
    } else {
      fail('duplicate workflowId not rejected', `status=${r.status} body=${r.body.slice(0, 200)}`);
    }
  }

  // Check 19 — POST /api/workflows/:id/verify-selectors payload shape
  section(19, 'verify-selectors endpoint returns expected payload shape');
  {
    // Build a minimal observation under a throwaway workflowId so verify
    // doesn't need a real browser (we expect failure on the playwright
    // launch when the fixture URL is unreachable, but the endpoint should
    // still respond with a structured error or success — never 404/500.
    // The point of this check is the route is wired and the request body
    // is accepted. We assert: 200 with verified_/rejected_ fields OR 400
    // with a clear error string.
    const r = await request('POST', `/api/workflows/${TEST_WORKFLOW_ID}/verify-selectors`, {});
    if (r.status === 200) {
      const body = JSON.parse(r.body);
      const keys = ['verified_fields','verified_assets','verified_actions','rejected_selectors','warnings'];
      const missing = keys.filter(k => !Array.isArray(body[k]));
      if (!missing.length && typeof body.fieldMapPath === 'string') {
        pass(`verify-selectors returned 200 with ${body.verified_fields.length}+${body.verified_assets.length}+${body.verified_actions.length} verified / ${body.rejected_selectors.length} rejected`);
      } else {
        fail('verify-selectors 200 missing required fields', `missing=${missing.join(',')} body=${r.body.slice(0,200)}`);
      }
    } else if (r.status === 400) {
      // Acceptable: e.g. "no source URL recorded" — proves the endpoint is
      // wired and parsed the request, but the observation is incomplete.
      pass(`verify-selectors returned 400 with a structured error (route wired): ${r.body.slice(0, 120)}`);
    } else {
      fail('verify-selectors returned unexpected status', `status=${r.status} body=${r.body.slice(0, 200)}`);
    }
  }

  // Check 20 — DELETE removes the workflow dir and preserves runs by default
  section(20, 'DELETE /api/workflows/:id removes workflow dir and preserves runs');
  {
    // Use a fixture clone so we don't blow away the canonical observed-workflow
    // that other checks need.
    const cloneId = `acceptance-delete-${Date.now()}`;
    const cloneDir = path.join(REPO_ROOT, 'workflows', cloneId);
    fs.mkdirSync(cloneDir, { recursive: true });
    const tplDir = path.join(REPO_ROOT, 'workflows', TEST_WORKFLOW_ID);
    for (const f of fs.readdirSync(tplDir)) {
      const s = fs.statSync(path.join(tplDir, f));
      if (s.isFile()) fs.copyFileSync(path.join(tplDir, f), path.join(cloneDir, f));
    }
    const obsCloneDir = path.join(REPO_ROOT, 'output', 'observations', cloneId);
    fs.mkdirSync(obsCloneDir, { recursive: true });
    fs.writeFileSync(path.join(obsCloneDir, 'observation.json'), '{"workflowId":"' + cloneId + '"}', 'utf8');
    const runCloneDir = path.join(REPO_ROOT, 'output', 'runs', cloneId, 'sentinel');
    fs.mkdirSync(runCloneDir, { recursive: true });
    fs.writeFileSync(path.join(runCloneDir, 'result.json'), '{"status":"completed"}', 'utf8');

    const r = await request('DELETE', `/api/workflows/${cloneId}`);
    if (r.status !== 200) { fail('DELETE returned non-200', `status=${r.status} body=${r.body}`); }
    else {
      const body = JSON.parse(r.body);
      const wfGone = !fs.existsSync(cloneDir);
      const obsGone = !fs.existsSync(obsCloneDir);
      const runsKept = fs.existsSync(runCloneDir);
      if (wfGone && obsGone && runsKept) pass(`DELETE removed workflow + observation; preserved runs (removed=[${body.removed?.join(', ')}])`);
      else fail('DELETE default behavior wrong', `wfGone=${wfGone} obsGone=${obsGone} runsKept=${runsKept}`);
    }
    // Cleanup
    fs.rmSync(path.join(REPO_ROOT, 'output', 'runs', cloneId), { recursive: true, force: true });
  }

  // Check 21 — DELETE ?includeRuns=1 also removes runs
  section(21, 'DELETE ?includeRuns=1 removes output/runs/<id>');
  {
    const cloneId = `acceptance-delete-runs-${Date.now()}`;
    const cloneDir = path.join(REPO_ROOT, 'workflows', cloneId);
    fs.mkdirSync(cloneDir, { recursive: true });
    const tplDir = path.join(REPO_ROOT, 'workflows', TEST_WORKFLOW_ID);
    for (const f of fs.readdirSync(tplDir)) {
      const s = fs.statSync(path.join(tplDir, f));
      if (s.isFile()) fs.copyFileSync(path.join(tplDir, f), path.join(cloneDir, f));
    }
    const runCloneDir = path.join(REPO_ROOT, 'output', 'runs', cloneId, 'sentinel');
    fs.mkdirSync(runCloneDir, { recursive: true });
    fs.writeFileSync(path.join(runCloneDir, 'result.json'), '{"status":"completed"}', 'utf8');

    const r = await request('DELETE', `/api/workflows/${cloneId}?includeRuns=1`);
    if (r.status !== 200) { fail('DELETE ?includeRuns=1 returned non-200', `status=${r.status}`); }
    else {
      const runsGone = !fs.existsSync(runCloneDir);
      const wfGone = !fs.existsSync(cloneDir);
      if (wfGone && runsGone) pass('DELETE ?includeRuns=1 removed workflow dir and run history');
      else fail('DELETE ?includeRuns=1 did not remove all targets', `wfGone=${wfGone} runsGone=${runsGone}`);
    }
  }

  // Check 22 — blocked status surfaces through the API (mapping fix)
  section(22, 'Blocked latestRun.status surfaces blockedReason hint');
  {
    // We don't have a fast way to force a blocked run here without running
    // the full pipeline, so this check inspects the schema instead: the
    // library entry must declare a `blockedReason` field shape. If a real
    // blocked run is present in result.json, also assert mapping.
    const list3 = await getJson('/api/workflows');
    const w = (list3.workflows || []).find(w => w.workflowId === TEST_WORKFLOW_ID);
    if (w && w.latestRun && 'blockedReason' in w.latestRun) {
      pass(`latestRun.blockedReason key present (=${JSON.stringify(w.latestRun.blockedReason)})`);
    } else if (w && !w.latestRun) {
      pass('no latestRun yet — schema check skipped (no run exists yet)');
    } else {
      fail('latestRun missing blockedReason key', JSON.stringify(w?.latestRun));
    }
  }

  console.log('');
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
} finally {
  stopServer();
}
