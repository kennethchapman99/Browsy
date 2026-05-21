#!/usr/bin/env node
import fs from 'fs';
import { join } from 'path';
import { REPO_ROOT } from '../src/core/paths.mjs';

const required = [
  'README.md',
  'AGENTS.md',
  'AUTOMATION_REQUEST.md',
  'package.json',
  'src/cli/index.mjs',
  'src/core/args.mjs',
  'src/core/paths.mjs',
  'src/core/safety.mjs',
  'src/core/discovery.mjs',
  'docs/architecture.md',
  'docs/agent-build-runbook.md',
  'templates/workflow/workflow.yaml',
  'templates/workflow/safety-policy.json',
  'examples/distrokid-upload/README.md'
];

let failed = 0;
for (const file of required) {
  const path = join(REPO_ROOT, file);
  if (!fs.existsSync(path)) {
    console.error('FAIL missing: ' + file);
    failed += 1;
  } else {
    console.log('PASS exists: ' + file);
  }
}

const pkg = JSON.parse(fs.readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
for (const script of ['smoke','validate:request','init:workflow','auth:save','auth:check','discover','generate:prompt','run']) {
  if (!pkg.scripts?.[script]) {
    console.error('FAIL missing package script: ' + script);
    failed += 1;
  } else {
    console.log('PASS package script: ' + script);
  }
}

const agents = fs.readFileSync(join(REPO_ROOT, 'AGENTS.md'), 'utf8');
for (const phrase of ['dry-run', 'Playwright', 'OpenClaw', 'APIs', 'human checkpoints']) {
  if (!agents.includes(phrase)) {
    console.error('FAIL AGENTS.md missing phrase: ' + phrase);
    failed += 1;
  } else {
    console.log('PASS AGENTS.md phrase: ' + phrase);
  }
}

if (failed) {
  console.error('\n' + failed + ' smoke checks failed.');
  process.exit(1);
}

console.log('\nPASS: Browsy smoke checks passed.');
