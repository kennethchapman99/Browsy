import { fileURLToPath } from 'url';
import { dirname, resolve, join } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const REPO_ROOT = resolve(__dirname, '../..');
export const WORKFLOWS_DIR = join(REPO_ROOT, 'workflows');
export const OUTPUT_DIR = join(REPO_ROOT, 'output');
export const AUTH_DIR = join(REPO_ROOT, '.auth');
export const REGISTRY_DIR = join(REPO_ROOT, 'registry');

export function workflowDir(workflow) {
  return join(WORKFLOWS_DIR, workflow);
}

export function workflowAuthPath(workflow) {
  return join(AUTH_DIR, workflow + '.json');
}

export function workflowRunDir(workflow, timestamp = new Date().toISOString().replace(/[:.]/g, '-')) {
  return join(OUTPUT_DIR, 'runs', workflow, timestamp);
}

export function ensureDir(path) {
  fs.mkdirSync(path, { recursive: true });
  return path;
}

export function exists(path) {
  return fs.existsSync(path);
}

export function readJson(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

export function writeJson(path, data) {
  ensureDir(dirname(path));
  fs.writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

export function writeText(path, text) {
  ensureDir(dirname(path));
  fs.writeFileSync(path, text);
}

export function safeId(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '') || 'workflow';
}
