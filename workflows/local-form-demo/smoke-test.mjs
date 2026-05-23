#!/usr/bin/env node
import fs from 'fs';
import { join } from 'path';
import { REPO_ROOT } from '../../src/core/paths.mjs';

const workflowDir = join(REPO_ROOT, 'workflows', 'local-form-demo');
const required = [
  'workflow.yaml', 'workflow.json', 'manifest.schema.json', 'manifest.example.json',
  'safety-policy.json', 'field-map.example.json', 'run.mjs', 'README.md'
];
let failed = 0;
for (const f of required) {
  const path = join(workflowDir, f);
  if (!fs.existsSync(path)) { console.error('FAIL missing: ' + f); failed++; }
  else console.log('PASS exists: ' + f);
}
if (failed) { console.error(failed + ' checks failed.'); process.exit(1); }
console.log('PASS: local-form-demo smoke checks passed.');
