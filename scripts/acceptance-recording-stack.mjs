#!/usr/bin/env node
import { spawnSync } from 'child_process';

const checks = [
  'scripts/acceptance-app-initiated-recording.mjs',
  'scripts/acceptance-wizard-observation-import-sidecars.mjs',
  'scripts/acceptance-record-import-contract-run.mjs',
  'scripts/acceptance-recording-session-ui.mjs',
  'scripts/acceptance-real-playwright-recording.mjs',
];

for (const script of checks) {
  console.log(`\nRunning ${script}`);
  const result = spawnSync(process.execPath, [script], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log('\nRecording stack acceptance checks passed.');
