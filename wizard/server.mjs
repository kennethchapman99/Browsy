#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PORT = 3333;

// Whitelisted commands — only these can be executed via /api/exec.
const ALLOWED_COMMANDS = new Set([
  'validate-request',
  'plan',
  'init',
  'auth',
  'discover',
  'discover:all',
  'run',
  'review',
  'feedback',
  'promote',
]);

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch (e) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// Derive lifecycle stage status from filesystem state.
function getWorkflowState(workflowId) {
  const wfDir = path.join(REPO_ROOT, 'workflows', workflowId);
  const runsDir = path.join(REPO_ROOT, 'output', 'runs', workflowId);
  const authFile = path.join(REPO_ROOT, '.auth', `${workflowId}.json`);

  const has = f => fs.existsSync(f);

  const scaffolded = has(path.join(wfDir, 'workflow.json'));
  const authed = has(authFile);
  const discovered = has(path.join(wfDir, 'field-map.local.json'));

  let latestRun = null;
  let hasReview = false;
  let hasErrors = false;
  if (has(runsDir)) {
    const runs = fs.readdirSync(runsDir).filter(d =>
      fs.statSync(path.join(runsDir, d)).isDirectory()
    ).sort().reverse();
    if (runs.length) {
      latestRun = runs[0];
      const runPath = path.join(runsDir, latestRun);
      hasReview = has(path.join(runPath, 'run-review.md'));
      const errorsPath = path.join(runPath, 'errors.json');
      if (has(errorsPath)) {
        try {
          const errs = JSON.parse(fs.readFileSync(errorsPath, 'utf8'));
          hasErrors = Array.isArray(errs) && errs.length > 0;
        } catch { hasErrors = false; }
      }
    }
  }

  const feedbackDir = path.join(wfDir, 'feedback');
  const hasFeedback = has(feedbackDir) && fs.readdirSync(feedbackDir).length > 0;
  const promoted = has(path.join(wfDir, 'PROMOTED'));

  return {
    workflowId,
    stages: {
      request: { done: has(path.join(REPO_ROOT, 'AUTOMATION_REQUEST.md')) },
      validate: { done: scaffolded },
      scaffold: { done: scaffolded },
      auth: { done: authed },
      discover: { done: discovered },
      'dry-run': { done: latestRun !== null, error: hasErrors, runId: latestRun },
      review: { done: hasReview, runId: latestRun },
      feedback: { done: hasFeedback },
      promote: { done: promoted },
    },
    latestRun,
    workflowDir: wfDir,
    runsDir,
  };
}

// List all workflows under workflows/.
function listWorkflows() {
  const wfRoot = path.join(REPO_ROOT, 'workflows');
  if (!fs.existsSync(wfRoot)) return [];
  return fs.readdirSync(wfRoot).filter(d =>
    fs.statSync(path.join(wfRoot, d)).isDirectory() &&
    fs.existsSync(path.join(wfRoot, d, 'workflow.json'))
  );
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Static assets
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/logo.png') {
    const logoPath = path.join(REPO_ROOT, 'Browsy_logo.png');
    if (fs.existsSync(logoPath)) {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(fs.readFileSync(logoPath));
    } else {
      res.writeHead(404); res.end();
    }
    return;
  }

  // Write AUTOMATION_REQUEST.md
  if (req.method === 'POST' && url.pathname === '/write-request') {
    try {
      const { markdown } = await readBody(req);
      if (typeof markdown !== 'string' || !markdown.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'markdown field required' }));
        return;
      }
      fs.writeFileSync(path.join(REPO_ROOT, 'AUTOMATION_REQUEST.md'), markdown, 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      console.log('[wizard] Wrote AUTOMATION_REQUEST.md');
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // GET /api/workflows — list all workflow IDs and their state
  if (req.method === 'GET' && url.pathname === '/api/workflows') {
    const ids = listWorkflows();
    const states = ids.map(id => getWorkflowState(id));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ workflows: states }));
    return;
  }

  // GET /api/state?workflow=<id>
  if (req.method === 'GET' && url.pathname === '/api/state') {
    const workflowId = url.searchParams.get('workflow');
    if (!workflowId) {
      // Return request-level state when no workflow specified
      const hasRequest = fs.existsSync(path.join(REPO_ROOT, 'AUTOMATION_REQUEST.md'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ hasRequest, workflows: listWorkflows() }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getWorkflowState(workflowId)));
    return;
  }

  // GET /api/artifact?workflow=<id>&run=<runId>&file=<filename>
  if (req.method === 'GET' && url.pathname === '/api/artifact') {
    const workflowId = url.searchParams.get('workflow');
    const runId = url.searchParams.get('run');
    const file = url.searchParams.get('file');
    if (!workflowId || !file) {
      res.writeHead(400); res.end(JSON.stringify({ error: 'workflow and file required' }));
      return;
    }

    let filePath;
    if (runId) {
      filePath = path.join(REPO_ROOT, 'output', 'runs', workflowId, runId, file);
    } else {
      // Serve from workflow dir (e.g. run-review.md from latest run)
      const runsDir = path.join(REPO_ROOT, 'output', 'runs', workflowId);
      if (fs.existsSync(runsDir)) {
        const runs = fs.readdirSync(runsDir).filter(d =>
          fs.statSync(path.join(runsDir, d)).isDirectory()
        ).sort().reverse();
        if (runs.length) {
          filePath = path.join(runsDir, runs[0], file);
        }
      }
    }

    if (!filePath || !fs.existsSync(filePath)) {
      res.writeHead(404); res.end(JSON.stringify({ error: 'artifact not found' }));
      return;
    }

    // Safety: ensure path stays within REPO_ROOT
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(REPO_ROOT)) {
      res.writeHead(403); res.end(JSON.stringify({ error: 'forbidden' }));
      return;
    }

    const ext = path.extname(file).toLowerCase();
    const contentType = ext === '.json' ? 'application/json'
      : ext === '.md' ? 'text/plain; charset=utf-8'
      : ext === '.html' ? 'text/html; charset=utf-8'
      : ext === '.png' ? 'image/png'
      : 'text/plain; charset=utf-8';

    res.writeHead(200, { 'Content-Type': contentType });
    res.end(fs.readFileSync(filePath));
    return;
  }

  // POST /api/exec — run a whitelisted CLI command, stream output
  if (req.method === 'POST' && url.pathname === '/api/exec') {
    let body;
    try { body = await readBody(req); }
    catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: 'invalid JSON' })); return; }

    const { command, args = [] } = body;

    if (!command || !ALLOWED_COMMANDS.has(command)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `command not allowed: ${command}` }));
      return;
    }

    // Validate args — only strings, no shell injection
    if (!Array.isArray(args) || args.some(a => typeof a !== 'string')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'args must be array of strings' }));
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const write = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    write('start', { command, args });

    const child = spawn('node', ['src/cli/index.mjs', command, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, FORCE_COLOR: '0' },
    });

    child.stdout.on('data', chunk => {
      for (const line of chunk.toString().split('\n')) {
        if (line) write('stdout', { line });
      }
    });
    child.stderr.on('data', chunk => {
      for (const line of chunk.toString().split('\n')) {
        if (line) write('stderr', { line });
      }
    });
    child.on('close', code => {
      write('done', { code });
      res.end();
    });
    child.on('error', err => {
      write('error', { message: err.message });
      res.end();
    });
    req.on('close', () => { child.kill(); });
    return;
  }

  res.writeHead(404); res.end('Not found');
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
