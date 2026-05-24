#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateExecArgs } from './arg-validator.mjs';
import { evaluateProjectReadiness, writeAutomationProjectDraft } from '../src/core/project-model.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PORT = 3333;

const ALLOWED_COMMANDS = new Set([
  'validate-request', 'plan', 'init', 'auth', 'discover', 'discover:all',
  'run', 'review', 'feedback', 'promote',
]);

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function has(filePath) { return fs.existsSync(filePath); }
function safeWorkflowId(id) { return /^[a-z0-9][a-z0-9\-_]{0,63}$/.test(id || ''); }
function json(res, status, payload) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); }

function latestRunInfo(runsDir) {
  if (!has(runsDir)) return { latestRun: null, latestRunDir: null, runs: [] };
  const runs = fs.readdirSync(runsDir)
    .filter(d => fs.statSync(path.join(runsDir, d)).isDirectory())
    .sort().reverse();
  const latestRun = runs[0] || null;
  return { latestRun, latestRunDir: latestRun ? path.join(runsDir, latestRun) : null, runs };
}

function getWorkflowState(workflowId) {
  const wfDir = path.join(REPO_ROOT, 'workflows', workflowId);
  const runsDir = path.join(REPO_ROOT, 'output', 'runs', workflowId);
  const authFile = path.join(REPO_ROOT, '.auth', `${workflowId}.json`);
  const outputObservationDir = path.join(REPO_ROOT, 'output', 'observations', workflowId);
  const { latestRun, latestRunDir, runs } = latestRunInfo(runsDir);

  const scaffolded = has(path.join(wfDir, 'workflow.json'));
  const projectDrafted = has(path.join(wfDir, 'project.json'));
  const validated = has(path.join(REPO_ROOT, 'output', 'plans', workflowId, 'build-plan.md'));

  let requestDone = false;
  const reqFile = path.join(REPO_ROOT, 'AUTOMATION_REQUEST.md');
  if (has(reqFile)) {
    try {
      const reqText = fs.readFileSync(reqFile, 'utf8');
      requestDone = reqText.includes(`\`${workflowId}\``) || reqText.includes(`"${workflowId}"`);
    } catch { requestDone = false; }
  }
  if (scaffolded || projectDrafted) requestDone = true;

  const hasDiscovery = has(runsDir) && runs.some(r => has(path.join(runsDir, r, 'discovered-fields.json')));
  let hasReview = false;
  let hasErrors = false;
  if (latestRunDir) {
    hasReview = has(path.join(latestRunDir, 'run-review.md'));
    const errorsPath = path.join(latestRunDir, 'errors.json');
    if (has(errorsPath)) {
      try { hasErrors = (JSON.parse(fs.readFileSync(errorsPath, 'utf8')) || []).length > 0; }
      catch { hasErrors = false; }
    }
  }

  const feedbackDir = path.join(wfDir, 'feedback');
  const readiness = evaluateProjectReadiness({ workflowDir: wfDir, runsDir, outputObservationDir });

  return {
    workflowId,
    stages: {
      request: { done: requestDone },
      validate: { done: validated || scaffolded || projectDrafted },
      package: { done: projectDrafted },
      observation: { done: readiness.states.observation_captured, needed: readiness.states.observation_needed },
      scaffold: { done: scaffolded },
      auth: { done: has(authFile) },
      discover: { done: hasDiscovery },
      'field-map': { done: readiness.states.field_map_verified, candidates: readiness.states.field_map_candidate_ready },
      'dry-run': { done: latestRun !== null, error: hasErrors, runId: latestRun },
      review: { done: hasReview, runId: latestRun },
      feedback: { done: has(feedbackDir) && fs.readdirSync(feedbackDir).length > 0 },
      'live-run': { done: readiness.states.live_run_completed, gated: readiness.states.live_run_gated },
      'output-capture': { done: readiness.states.output_capture_completed },
      promote: { done: has(path.join(wfDir, 'PROMOTED')) },
    },
    readiness,
    latestRun,
    workflowDir: wfDir,
    runsDir,
  };
}

function listWorkflows() {
  const wfRoot = path.join(REPO_ROOT, 'workflows');
  if (!has(wfRoot)) return [];
  return fs.readdirSync(wfRoot).filter(d => {
    const dir = path.join(wfRoot, d);
    return fs.statSync(dir).isDirectory() && (has(path.join(dir, 'workflow.json')) || has(path.join(dir, 'project.json')));
  });
}

function contentTypeFor(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.json') return 'application/json';
  if (ext === '.md') return 'text/plain; charset=utf-8';
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.png') return 'image/png';
  if (ext === '.yaml' || ext === '.yml') return 'text/yaml; charset=utf-8';
  return 'text/plain; charset=utf-8';
}

function repoSafe(filePath) {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(REPO_ROOT)) throw new Error('forbidden');
  return resolved;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/logo.png') {
    const logoPath = path.join(REPO_ROOT, 'Browsy_logo.png');
    if (has(logoPath)) { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(fs.readFileSync(logoPath)); }
    else { res.writeHead(404); res.end(); }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/write-request') {
    try {
      const { markdown } = await readBody(req);
      if (typeof markdown !== 'string' || !markdown.trim()) return json(res, 400, { error: 'markdown field required' });
      fs.writeFileSync(path.join(REPO_ROOT, 'AUTOMATION_REQUEST.md'), markdown, 'utf8');
      json(res, 200, { ok: true });
      console.log('[wizard] Wrote AUTOMATION_REQUEST.md');
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/write-package') {
    try {
      const { package: pkg, workflowId } = await readBody(req);
      if (!pkg || typeof pkg !== 'object') return json(res, 400, { error: 'package object required' });
      if (!safeWorkflowId(workflowId)) return json(res, 400, { error: 'valid workflowId required' });
      const result = writeAutomationProjectDraft({ repoRoot: REPO_ROOT, workflowId, automationPackage: pkg });
      json(res, 200, { ok: true, path: result.packagePath, files: result.relativeFiles });
      console.log(`[wizard] Wrote automation project draft for ${result.workflowId}`);
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/workflows') {
    return json(res, 200, { workflows: listWorkflows().map(id => getWorkflowState(id)) });
  }

  if (req.method === 'GET' && url.pathname === '/api/state') {
    const workflowId = url.searchParams.get('workflow');
    if (!workflowId) return json(res, 200, { hasRequest: has(path.join(REPO_ROOT, 'AUTOMATION_REQUEST.md')), workflows: listWorkflows() });
    return json(res, 200, getWorkflowState(workflowId));
  }

  if (req.method === 'GET' && url.pathname === '/api/artifact') {
    const workflowId = url.searchParams.get('workflow');
    const runId = url.searchParams.get('run');
    const file = url.searchParams.get('file');
    if (!safeWorkflowId(workflowId) || !file) return json(res, 400, { error: 'workflow and file required' });

    let filePath;
    if (runId) filePath = path.join(REPO_ROOT, 'output', 'runs', workflowId, runId, file);
    else {
      const { latestRunDir } = latestRunInfo(path.join(REPO_ROOT, 'output', 'runs', workflowId));
      if (latestRunDir) filePath = path.join(latestRunDir, file);
      if (!filePath || !has(filePath)) filePath = path.join(REPO_ROOT, 'workflows', workflowId, file);
    }
    if (!filePath || !has(filePath)) return json(res, 404, { error: 'artifact not found' });
    try { filePath = repoSafe(filePath); } catch { return json(res, 403, { error: 'forbidden' }); }
    res.writeHead(200, { 'Content-Type': contentTypeFor(file) });
    res.end(fs.readFileSync(filePath));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/artifact-list') {
    const workflowId = url.searchParams.get('workflow');
    if (!safeWorkflowId(workflowId)) return json(res, 400, { error: 'valid workflow id required' });
    const wfDir = path.join(REPO_ROOT, 'workflows', workflowId);
    const runsDir = path.join(REPO_ROOT, 'output', 'runs', workflowId);
    const wfFiles = [
      'project.json','workflow.json','workflow.yaml','manifest.schema.json','manifest.example.json','workflow-package.example.json',
      'safety-policy.json','field-map.example.json','field-map.local.json.example','field-map.local.json','walkthrough.md','README.md',
      'run.mjs','smoke-test.mjs','observations/atlas-observation-template.md','observations/observation-checklist.md',
      'fixtures/observed-form.html','fixtures/observed-review.html','fixtures/observed-success.html','PROMOTED',
    ];
    const wfArtifacts = wfFiles.map(file => ({ file, scope: 'workflow', path: `workflows/${workflowId}/${file}`, exists: has(path.join(wfDir, file)) }));

    const feedbackDir = path.join(wfDir, 'feedback');
    const feedbackFiles = has(feedbackDir) ? fs.readdirSync(feedbackDir).map(file => ({ file, scope: 'feedback', path: `workflows/${workflowId}/feedback/${file}`, exists: true })) : [];

    const { latestRun, latestRunDir } = latestRunInfo(runsDir);
    const runFiles = ['run-review.md','run-log.json','filled-fields.json','skipped-fields.json','errors.json','runtime-vars.json','captured-outputs.json','discovered-fields.json','discovered-fields.md','field-map.candidates.md','page-text-snapshot.txt','html-snapshot.html','screenshot-start.png','screenshot-after-fill.png','screenshot-discovery.png','live-run-completed.json'];
    const runArtifacts = latestRunDir ? runFiles.map(file => ({ file, scope: 'run', runId: latestRun, path: `output/runs/${workflowId}/${latestRun}/${file}`, exists: has(path.join(latestRunDir, file)) })) : [];

    return json(res, 200, {
      workflowId,
      latestRun,
      readiness: evaluateProjectReadiness({ workflowDir: wfDir, runsDir, outputObservationDir: path.join(REPO_ROOT, 'output', 'observations', workflowId) }),
      artifacts: [...wfArtifacts, ...feedbackFiles, ...runArtifacts],
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/exec') {
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: 'invalid JSON' }); }
    const { command, args = [] } = body;
    if (!command || !ALLOWED_COMMANDS.has(command)) return json(res, 400, { error: `command not allowed: ${command}` });
    if (!Array.isArray(args) || args.some(a => typeof a !== 'string')) return json(res, 400, { error: 'args must be an array of strings' });
    const argCheck = validateExecArgs(command, args);
    if (!argCheck.ok) return json(res, 400, { error: `invalid args: ${argCheck.reason}` });

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const write = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    write('start', { command, args });
    const child = spawn('node', ['src/cli/index.mjs', command, ...args], { cwd: REPO_ROOT, env: { ...process.env, FORCE_COLOR: '0' } });
    child.stdout.on('data', chunk => { for (const line of chunk.toString().split('\n')) if (line) write('stdout', { line }); });
    child.stderr.on('data', chunk => { for (const line of chunk.toString().split('\n')) if (line) write('stderr', { line }); });
    child.on('close', code => { write('done', { code }); res.end(); });
    child.on('error', err => { write('error', { message: err.message }); res.end(); });
    req.on('close', () => { child.kill(); });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.log('');
    console.log(`  Port ${PORT} is already in use.`);
    console.log(`  The wizard may already be running — open: http://localhost:${PORT}`);
    console.log('  If it is not, kill the process using that port and retry.');
    console.log('');
    process.exit(0);
  }
  console.error('  Server error:', err.message);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  Browsy Wizard');
  console.log(`  http://localhost:${PORT}`);
  console.log('');
  console.log('  Open the URL above in Chrome for best voice support.');
  console.log('  Ctrl+C to stop.');
  console.log('');
});
