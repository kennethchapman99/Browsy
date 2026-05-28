// Generic public run/result contract helpers for registry callers.
//
// This module is intentionally app-agnostic. It converts internal Browsy run
// records and engine results into the stable shape external apps, CLIs, UIs,
// and agents consume.

export const REGISTRY_CONTRACT_VERSION = '1.0.0';

export const PUBLIC_RUN_STATUSES = [
  'created',
  'running',
  'waiting_for_auth',
  'waiting_for_2fa',
  'waiting_for_human_review',
  'waiting_for_file_selection',
  'waiting_for_manual_page_fix',
  'waiting_for_approval',
  'waiting_for_approval_to_submit',
  'completed',
  'failed',
  'blocked',
  'canceled',
];

export function toPublicStatus(run = {}) {
  if (run.status && PUBLIC_RUN_STATUSES.includes(run.status)) return run.status;

  const ps = run.processStatus;
  if (PUBLIC_RUN_STATUSES.includes(ps)) return ps;

  if (ps === 'stopped' || run.workflowOutcome === 'stopped') return 'canceled';
  if (ps === 'rejected') return 'failed';
  if (ps === 'failed') return 'failed';
  if (ps === 'completed') {
    if (run.workflowOutcome === 'success') return 'completed';
    if (run.workflowOutcome === 'blocked') return 'blocked';
    return run.workflowOutcome === 'failed' ? 'failed' : 'completed';
  }
  if (ps === 'running') return 'running';
  return 'created';
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function asArtifactObject(value, fallbackType = 'file') {
  if (!value) return null;
  if (typeof value === 'string') {
    return { name: value.split('/').pop(), path: value, type: fallbackType };
  }
  if (typeof value === 'object') {
    return {
      name: value.name || value.path?.split('/').pop() || value.file || value.url || 'artifact',
      path: value.path || value.file || value.url || null,
      type: value.type || fallbackType,
      ...value,
    };
  }
  return null;
}

function dedupeByPath(items = []) {
  const map = new Map();
  for (const item of items) {
    if (!item) continue;
    const key = item.path || item.name;
    if (!key || map.has(key)) continue;
    map.set(key, item);
  }
  return [...map.values()];
}

export function groupArtifacts(run = {}) {
  const internal = run.internalRunResult || {};
  const all = [
    ...normalizeArray(run.artifacts),
    ...normalizeArray(internal.artifacts),
    ...normalizeArray(internal.artifact_paths).map(p => ({ path: p, name: String(p).split('/').pop(), type: 'file' })),
  ].map(a => asArtifactObject(a)).filter(Boolean);

  const screenshots = dedupeByPath([
    ...normalizeArray(internal.screenshots).map(s => asArtifactObject(s, 'screenshot')),
    ...all.filter(a => a.type === 'screenshot' || /\.(png|jpg|jpeg|webp)$/i.test(a.path || a.name || '')),
  ].filter(Boolean));

  const downloads = dedupeByPath([
    ...normalizeArray(internal.downloaded_files).map(d => asArtifactObject(d, 'download')),
    ...all.filter(a => a.type === 'download' || a.type === 'downloaded_file'),
  ].filter(Boolean));

  const logs = dedupeByPath(all.filter(a => a.type === 'log' || /log|result|json|txt/i.test(a.name || '')));
  const trace = dedupeByPath(all.filter(a => a.type === 'trace' || /trace/i.test(a.name || a.path || '')));

  return { screenshots, downloads, trace, logs };
}

export function buildRunResult(run = {}) {
  const internal = run.internalRunResult || {};
  const status = toPublicStatus(run);
  const artifacts = groupArtifacts(run);

  return {
    runId: run.runId,
    status,
    contractVersion: REGISTRY_CONTRACT_VERSION,
    completedSteps: normalizeArray(internal.completedSteps || internal.completed_steps || internal.filled_fields),
    failedSteps: normalizeArray(internal.failedSteps || internal.failed_steps || internal.errors),
    skippedSteps: normalizeArray(internal.skippedSteps || internal.skipped_steps || internal.skipped_fields),
    uploadedFiles: normalizeArray(internal.uploaded_files || internal.uploadedFiles),
    checkpoints: normalizeArray(internal.manual_checkpoints || internal.checkpoints),
    outputs: internal.outputs || internal.captured_outputs || run.outputs || {},
    materializedPackage: internal.materializedPackage || null,
    artifacts,
    blockingReason: run.blockingReason || internal.blockingReason || internal.next_required_action || null,
  };
}

export function buildRunCreateResponse(run = {}) {
  return {
    runId: run.runId,
    status: toPublicStatus(run),
    contractVersion: REGISTRY_CONTRACT_VERSION,
    statusUrl: `/api/runs/${run.runId}`,
  };
}

export function buildWorkflowContract(workflowVersion, { baseUrl = 'http://localhost:3001' } = {}) {
  const schema = workflowVersion.inputSchema || {};
  const requiredPayloadFields = Array.isArray(schema.required) ? schema.required : [];
  const allFields = Object.keys(schema.properties || {});
  const optionalPayloadFields = allFields.filter(f => !requiredPayloadFields.includes(f));

  const examplePayload = {};
  for (const f of requiredPayloadFields) {
    const prop = schema.properties?.[f] || {};
    if (prop.type === 'number') examplePayload[f] = 0;
    else if (prop.type === 'boolean') examplePayload[f] = false;
    else if (prop.type === 'array') examplePayload[f] = [];
    else if (prop.type === 'object') examplePayload[f] = {};
    else examplePayload[f] = `<${f}>`;
  }

  return {
    workflowRef: `${workflowVersion.workflowObjectId}@${workflowVersion.version}`,
    appId: workflowVersion.appId,
    workflowId: workflowVersion.workflowId,
    name: workflowVersion.name || workflowVersion.workflowId,
    description: workflowVersion.description || '',
    version: workflowVersion.version,
    contractVersion: REGISTRY_CONTRACT_VERSION,
    requiredPayloadFields,
    optionalPayloadFields,
    inputSchema: workflowVersion.inputSchema || {},
    outputSchema: workflowVersion.outputSchema || {},
    requiredFiles: workflowVersion.requiredFiles || [],
    requiredAssets: workflowVersion.requiredAssets || [],
    tabs: workflowVersion.tabs || [],
    auth: workflowVersion.auth || [],
    recordedSteps: workflowVersion.recordedSteps || [],
    bindings: workflowVersion.variableBindings || {},
    fileUploadBindings: workflowVersion.fileUploadBindings || [],
    humanApprovalCheckpoints: workflowVersion.humanApprovalCheckpoints || [],
    expectedOutputs: workflowVersion.expectedOutputs || [],
    validationRules: workflowVersion.validationRules || [],
    replaySettings: workflowVersion.replaySettings || {},
    supportedModes: workflowVersion.supportedModes || [],
    runEndpoint: `POST ${baseUrl}/api/apps/${workflowVersion.appId}/workflows/${workflowVersion.workflowId}/runs`,
    runStatusEndpoint: `GET ${baseUrl}/api/runs/:runId`,
    approveEndpoint: `POST ${baseUrl}/api/runs/:runId/approve`,
    cancelEndpoint: `POST ${baseUrl}/api/runs/:runId/cancel`,
    artifactEndpoint: `GET ${baseUrl}/api/runs/:runId/artifacts`,
    exampleCLIRun: `browsy workflow run ${workflowVersion.workflowObjectId}@${workflowVersion.version} --payload payload.json --mode preview`,
    exampleHTTPBody: {
      mode: 'preview',
      payload: examplePayload,
      options: {
        leaveBrowserOpen: true,
        requireHumanApproval: true,
        artifactMode: 'capture_all',
      },
    },
  };
}
