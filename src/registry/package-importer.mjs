// Workflow package import — validates a workflow package directory and registers
// it as a versioned workflow in the Browsy registry.

import fs from 'fs';
import { join, resolve } from 'path';
import { exists, readJson } from '../core/paths.mjs';
import { getApp, registerApp } from './app-registry.mjs';
import { registerWorkflow } from './workflow-registry.mjs';
import { extractWorkflowPackageMetadata, validateGenericSteps } from './generic-actions.mjs';

const REQUIRED_FILES = ['workflow.json', 'manifest.schema.json'];
const EXECUTION_PKG_CANDIDATES = ['workflow-package.local.json', 'workflow-package.example.json'];

function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

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

  let workflowJson;
  try {
    workflowJson = readJson(join(abs, 'workflow.json'));
  } catch (e) {
    return { ok: false, errors: [`workflow.json invalid JSON: ${e.message}`], metadata: null };
  }
  if (!workflowJson.id || typeof workflowJson.id !== 'string') {
    errors.push('workflow.json must have a string "id" field');
  }

  let inputSchema;
  try {
    inputSchema = readJson(join(abs, 'manifest.schema.json'));
  } catch (e) {
    errors.push(`manifest.schema.json invalid JSON: ${e.message}`);
  }
  if (errors.length) return { ok: false, errors, metadata: null };

  let executionPackagePath = null;
  let executionPackage = {};
  for (const f of EXECUTION_PKG_CANDIDATES) {
    const candidate = join(abs, f);
    if (exists(candidate)) {
      executionPackagePath = candidate;
      try { executionPackage = readJson(candidate); } catch { executionPackage = {}; }
      break;
    }
  }

  const generic = extractWorkflowPackageMetadata(workflowJson, executionPackage);
  const stepErrors = validateGenericSteps(generic.recordedSteps);
  if (stepErrors.length) return { ok: false, errors: stepErrors, metadata: null };

  const requiredAssets = [
    ...arrayOrEmpty(executionPackage.assets).map(a => a.role || a.path || null).filter(Boolean),
    ...arrayOrEmpty(generic.requiredFiles),
  ];

  const requiredInputs = Array.isArray(inputSchema?.required) ? inputSchema.required : [];
  const supportedModes = workflowJson.supported_modes || workflowJson.supportedModes || ['preview', 'live', 'dry_run'];

  const metadata = {
    packageWorkflowId: workflowJson.id,
    inputSchema: inputSchema || {},
    requiredInputs,
    requiredAssets,
    supportedModes,
    executionPackagePath,
    hasRealExecutor: !!executionPackagePath,
    ...generic,
  };

  return { ok: true, errors: [], metadata };
}

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
      name: metadata.name || workflowId,
      description: metadata.description || '',
      inputSchema: metadata.inputSchema,
      outputSchema: metadata.outputSchema,
      requiredFiles: metadata.requiredFiles,
      requiredAssets: metadata.requiredAssets,
      supportedModes: metadata.supportedModes,
      safetyPolicy: metadata.safetyPolicy,
      artifactPolicy: metadata.artifactPolicy,
      successAssertions: metadata.successAssertions,
      failureAssertions: metadata.failureAssertions,
      packagePath: abs,
      packageWorkflowId: metadata.packageWorkflowId,
      tabs: metadata.tabs,
      auth: metadata.auth,
      humanApprovalCheckpoints: metadata.humanApprovalCheckpoints,
      recordedSteps: metadata.recordedSteps,
      variableBindings: metadata.variableBindings,
      fileUploadBindings: metadata.fileUploadBindings,
      expectedOutputs: metadata.expectedOutputs,
      validationRules: metadata.validationRules,
      replaySettings: metadata.replaySettings,
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
    tabs: metadata.tabs,
    auth: metadata.auth,
    humanApprovalCheckpoints: metadata.humanApprovalCheckpoints,
    expectedOutputs: metadata.expectedOutputs,
  };
}
