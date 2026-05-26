// Workflow package import — validates a workflow package directory and registers
// it as a versioned workflow in the Browsy registry.
//
// A workflow package directory must contain:
//   workflow.json         — workflow config with an "id" field
//   manifest.schema.json  — JSON Schema for the input payload
//
// Optional (enables real browser execution):
//   workflow-package.local.json   — preferred execution entrypoint
//   workflow-package.example.json — fallback execution entrypoint

import fs from 'fs';
import { join, resolve } from 'path';
import { exists, readJson } from '../core/paths.mjs';
import { getApp, registerApp } from './app-registry.mjs';
import { registerWorkflow } from './workflow-registry.mjs';

const REQUIRED_FILES = ['workflow.json', 'manifest.schema.json'];
const EXECUTION_PKG_CANDIDATES = ['workflow-package.local.json', 'workflow-package.example.json'];

// Validate a workflow package directory and extract metadata.
// Returns { ok, errors, metadata }.
// metadata is null when ok === false.
export function validateWorkflowPackageDir(packagePath) {
  const abs = resolve(packagePath);
  const errors = [];

  if (!exists(abs)) {
    return { ok: false, errors: [`package path not found: ${abs}`], metadata: null };
  }

  let stat;
  try { stat = fs.statSync(abs); } catch (e) {
    return { ok: false, errors: [`cannot stat package path: ${e.message}`], metadata: null };
  }
  if (!stat.isDirectory()) {
    return { ok: false, errors: [`package path must be a directory: ${abs}`], metadata: null };
  }

  for (const f of REQUIRED_FILES) {
    if (!exists(join(abs, f))) errors.push(`missing required file: ${f}`);
  }

  if (errors.length) return { ok: false, errors, metadata: null };

  // workflow.json
  let workflowJson;
  try {
    workflowJson = readJson(join(abs, 'workflow.json'));
  } catch (e) {
    return { ok: false, errors: [`workflow.json invalid JSON: ${e.message}`], metadata: null };
  }
  if (!workflowJson.id || typeof workflowJson.id !== 'string') {
    errors.push('workflow.json must have a string "id" field');
  }

  // manifest.schema.json
  let inputSchema;
  try {
    inputSchema = readJson(join(abs, 'manifest.schema.json'));
  } catch (e) {
    errors.push(`manifest.schema.json invalid JSON: ${e.message}`);
  }

  if (errors.length) return { ok: false, errors, metadata: null };

  // Optional: execution entrypoint
  let executionPackagePath = null;
  for (const f of EXECUTION_PKG_CANDIDATES) {
    const candidate = join(abs, f);
    if (exists(candidate)) { executionPackagePath = candidate; break; }
  }

  // Derive requiredAssets from execution package if present
  let requiredAssets = [];
  if (executionPackagePath) {
    try {
      const execPkg = readJson(executionPackagePath);
      requiredAssets = (execPkg.assets || [])
        .map(a => a.role || a.path || null)
        .filter(Boolean);
    } catch { /* ignore — entrypoint file is optional */ }
  }

  const requiredInputs = Array.isArray(inputSchema?.required) ? inputSchema.required : [];
  const supportedModes = workflowJson.supported_modes || ['preview', 'live', 'discover', 'repair'];

  const metadata = {
    packageWorkflowId: workflowJson.id,
    inputSchema: inputSchema || {},
    requiredInputs,
    requiredAssets,
    supportedModes,
    executionPackagePath,
    hasRealExecutor: !!executionPackagePath,
    description: workflowJson.description || '',
  };

  return { ok: true, errors: [], metadata };
}

// Import a workflow package directory into the registry.
//
// Options:
//   packagePath     — path to the workflow package directory
//   appId           — target app ID (must be registered, unless autoRegisterApp is true)
//   workflowId      — workflow ID to register under
//   version         — semver version string (default: '1.0.0')
//   autoRegisterApp — if true, register app automatically (requires appName)
//   appName         — app display name (required when autoRegisterApp is true)
//
// Returns { ok, errors?, appId, workflowId, version, workflowRef, packagePath,
//           requiredInputs, requiredAssets, supportedModes, hasRealExecutor }
export function importWorkflowPackage({
  packagePath,
  appId,
  workflowId,
  version = '1.0.0',
  autoRegisterApp = false,
  appName,
}) {
  if (!appId) return { ok: false, errors: ['appId is required'] };
  if (!workflowId) return { ok: false, errors: ['workflowId is required'] };

  const abs = resolve(packagePath);
  const validation = validateWorkflowPackageDir(abs);
  if (!validation.ok) return { ok: false, errors: validation.errors };

  const { metadata } = validation;

  // App registration
  let app = getApp(appId);
  if (!app) {
    if (autoRegisterApp) {
      if (!appName) return { ok: false, errors: [`app "${appId}" not found. Provide --app-name to auto-register.`] };
      try {
        app = registerApp({ appId, name: appName });
      } catch (e) {
        return { ok: false, errors: [`failed to auto-register app "${appId}": ${e.message}`] };
      }
    } else {
      return {
        ok: false,
        errors: [
          `app "${appId}" is not registered. `,
          `Register it first: POST /api/apps/register or use --register-app --app-name "<name>".`,
        ],
      };
    }
  }

  try {
    registerWorkflow({
      appId,
      workflowId,
      version,
      inputSchema: metadata.inputSchema,
      supportedModes: metadata.supportedModes,
      packagePath: abs,
      packageWorkflowId: metadata.packageWorkflowId,
    });
  } catch (e) {
    return { ok: false, errors: [e.message] };
  }

  const workflowRef = `${appId}.${workflowId}@${version}`;

  return {
    ok: true,
    appId,
    workflowId,
    version,
    workflowRef,
    packagePath: abs,
    packageWorkflowId: metadata.packageWorkflowId,
    requiredInputs: metadata.requiredInputs,
    requiredAssets: metadata.requiredAssets,
    supportedModes: metadata.supportedModes,
    hasRealExecutor: metadata.hasRealExecutor,
  };
}
