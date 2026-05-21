#!/usr/bin/env node
import fs from 'fs';
import { join } from 'path';
import { parseArgs, requireArg, boolArg } from '../core/args.mjs';
import { REPO_ROOT, WORKFLOWS_DIR, workflowDir, workflowAuthPath, workflowRunDir, ensureDir, exists, writeText, safeId } from '../core/paths.mjs';
import { defaultSafetyPolicy } from '../core/safety.mjs';
import { launchBrowser, writeDiscoveryArtifacts } from '../core/discovery.mjs';

const argv = process.argv.slice(2);
const command = argv[0];
const subcommand = argv[1];
const args = parseArgs(argv.slice(command === 'auth' ? 2 : 1));

function printHelp() {
  console.log('Browsy automation harness factory');
  console.log('Commands:');
  console.log('  browsy validate-request');
  console.log('  browsy init --id workflow-id');
  console.log('  browsy auth save --workflow workflow-id --url https://site/login');
  console.log('  browsy auth check --workflow workflow-id --url https://site/page');
  console.log('  browsy discover --workflow workflow-id --url https://site/page');
  console.log('  browsy generate-prompt');
  console.log('  browsy run --workflow workflow-id --manifest path/to/manifest.json --dry-run');
}

function readRequest() {
  const path = join(REPO_ROOT, 'AUTOMATION_REQUEST.md');
  if (!exists(path)) throw new Error('AUTOMATION_REQUEST.md not found');
  return fs.readFileSync(path, 'utf8');
}

function validateRequest() {
  const text = readRequest();
  const required = ['## 1. Workflow name','## 2. Goal','## 3. Target websites / pages','## 6. Desired workflow steps','## 8. Actions that must stay manual','## 12. Safety policy','## 15. Acceptance criteria','## 16. Narrated walkthrough'];
  const missing = required.filter(section => !text.includes(section));
  if (missing.length) {
    console.error('FAIL: AUTOMATION_REQUEST.md is missing required sections:');
    missing.forEach(item => console.error('- ' + item));
    process.exit(1);
  }
  console.log('PASS: AUTOMATION_REQUEST.md has the expected sections.');
}

function initWorkflow() {
  const id = safeId(requireArg(args, 'id', 'Example: npm run init:workflow -- --id distrokid-upload'));
  const dir = workflowDir(id);
  ensureDir(dir);
  const files = {
    'workflow.yaml': `id: ${id}\ndescription: Generated Browsy workflow.\nauth:\n  mode: manual-save-state\nruntime:\n  dry_run_default: true\n  headed_default: true\n  pause_at_end_default: true\n`,
    'manifest.schema.json': JSON.stringify({ type: 'object', required: ['id'], properties: { id: { type: 'string' } } }, null, 2) + '\n',
    'manifest.example.json': JSON.stringify({ id: 'ITEM_123' }, null, 2) + '\n',
    'safety-policy.json': JSON.stringify(defaultSafetyPolicy(), null, 2) + '\n',
    'field-map.example.json': JSON.stringify({ fields: {}, notes: 'Run discovery and create field-map.local.json from verified selectors.' }, null, 2) + '\n',
    'field-map.local.json.example': JSON.stringify({ fields: {} }, null, 2) + '\n',
    'walkthrough.md': '# Walkthrough\n\nExplain the workflow decisions here.\n',
    'README.md': `# ${id}\n\nGenerated Browsy workflow scaffold.\n`,
    'run.mjs': `#!/usr/bin/env node\nconsole.log('Workflow ${id} runner placeholder. A coding agent should replace this with the completed automation.');\n`,
    'smoke-test.mjs': `#!/usr/bin/env node\nconsole.log('PASS: ${id} smoke placeholder');\n`
  };
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    if (!exists(path)) fs.writeFileSync(path, content);
  }
  console.log('Created workflow scaffold: ' + dir);
}

async function authSave() {
  const workflow = safeId(requireArg(args, 'workflow'));
  const url = requireArg(args, 'url');
  ensureDir(join(REPO_ROOT, '.auth'));
  const authPath = workflowAuthPath(workflow);
  console.log('Launching browser for manual auth. Log in, then close the browser after auth saves.');
  const { browser, context, page } = await launchBrowser({ headed: true });
  async function save(trigger) {
    try {
      await context.storageState({ path: authPath });
      console.log('[auth] saved ' + workflow + ' (' + trigger + ') at ' + new Date().toISOString());
    } catch {}
  }
  page.on('load', () => save('load'));
  page.on('domcontentloaded', () => save('domcontentloaded'));
  page.on('framenavigated', () => save('framenavigated'));
  const interval = setInterval(() => save('interval'), 5000);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await new Promise(resolve => browser.on('disconnected', resolve));
  clearInterval(interval);
  if (!exists(authPath)) throw new Error('Auth file was not saved: ' + authPath);
  console.log('Auth saved: ' + authPath);
}

async function authCheck() {
  const workflow = safeId(requireArg(args, 'workflow'));
  const url = requireArg(args, 'url');
  const authPath = workflowAuthPath(workflow);
  if (!exists(authPath)) throw new Error('Missing auth file. Run auth save first: ' + authPath);
  const runDir = workflowRunDir(workflow, 'auth-check');
  const { browser, page } = await launchBrowser({ headed: boolArg(args.headed, true), storageState: authPath });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  ensureDir(runDir);
  await page.screenshot({ path: join(runDir, 'auth-check.png'), fullPage: true }).catch(() => {});
  writeText(join(runDir, 'auth-check-url.txt'), page.url() + '\n');
  console.log('Reached: ' + page.url());
  console.log('Artifacts: ' + runDir);
  await browser.close();
}

async function discover() {
  const workflow = safeId(requireArg(args, 'workflow'));
  const url = requireArg(args, 'url');
  const authPath = workflowAuthPath(workflow);
  const storageState = exists(authPath) ? authPath : undefined;
  const runDir = workflowRunDir(workflow);
  const { browser, page } = await launchBrowser({ headed: boolArg(args.headed, true), storageState });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await writeDiscoveryArtifacts(page, runDir);
  console.log('Discovery written: ' + runDir);
  if (boolArg(args.pause, false)) {
    console.log('Browser left open. Close it when done.');
    await new Promise(resolve => browser.on('disconnected', resolve));
  } else {
    await browser.close();
  }
}

function generatePrompt() {
  const request = readRequest();
  console.log('# Coding Agent Prompt\n');
  console.log('Read AGENTS.md and build the completed automation harness described in AUTOMATION_REQUEST.md.\n');
  console.log(request);
}

async function runWorkflow() {
  const workflow = safeId(requireArg(args, 'workflow'));
  const runner = join(workflowDir(workflow), 'run.mjs');
  if (!exists(runner)) throw new Error('Missing workflow runner: ' + runner);
  const { spawnSync } = await import('child_process');
  const result = spawnSync(process.execPath, [runner, ...process.argv.slice(3)], { stdio: 'inherit', cwd: REPO_ROOT });
  process.exit(result.status ?? 1);
}

try {
  if (!command || command === 'help' || command === '--help') printHelp();
  else if (command === 'validate-request') validateRequest();
  else if (command === 'init') initWorkflow();
  else if (command === 'auth' && subcommand === 'save') await authSave();
  else if (command === 'auth' && subcommand === 'check') await authCheck();
  else if (command === 'discover') await discover();
  else if (command === 'generate-prompt') generatePrompt();
  else if (command === 'run') await runWorkflow();
  else { printHelp(); process.exit(1); }
} catch (error) {
  console.error('FAIL: ' + error.message);
  process.exit(1);
}
