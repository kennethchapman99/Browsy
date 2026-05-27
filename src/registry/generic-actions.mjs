export const GENERIC_ACTION_TYPES = [
  'navigate',
  'click',
  'fill',
  'select',
  'uploadFile',
  'waitForSelector',
  'waitForUrl',
  'extractText',
  'extractAttribute',
  'screenshot',
  'download',
  'approve',
  'branch',
  'retry',
  'assert',
];

const GENERIC_ACTION_SET = new Set(GENERIC_ACTION_TYPES);

export function validateGenericSteps(steps = []) {
  const errors = [];
  if (!Array.isArray(steps)) return ['steps must be an array when present'];
  for (const [idx, step] of steps.entries()) {
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      errors.push(`steps[${idx}] must be an object`);
      continue;
    }
    const type = step.type || step.action;
    if (!type || typeof type !== 'string') {
      errors.push(`steps[${idx}] must have a string type/action`);
      continue;
    }
    if (!GENERIC_ACTION_SET.has(type)) {
      errors.push(`steps[${idx}] uses unsupported action "${type}". Use generic actions only: ${GENERIC_ACTION_TYPES.join(', ')}`);
    }
  }
  return errors;
}

function array(value) { return Array.isArray(value) ? value : []; }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }

function tabsFromTargets(workflowJson = {}) {
  return array(workflowJson.targets?.pages || workflowJson.pages).map(page => ({
    tabId: page.tabId || page.id,
    id: page.id,
    role: page.role || page.purpose || 'target',
    startUrl: page.startUrl || page.url || page.urlTemplate,
    url: page.url || page.startUrl || page.urlTemplate,
    requiresAuth: page.requiresAuth === true,
    authProfileId: page.authProfileId || null,
  })).filter(t => t.tabId || t.url || t.startUrl);
}

function repeatGroupsFromExecutionPackage(executionPackage = {}) {
  return array(executionPackage.repeatGroups || executionPackage.repeat_groups || executionPackage.canonical_payload?.repeatGroups);
}

function fileBindingsFromAssets(executionPackage = {}) {
  return array(executionPackage.assets).map(asset => {
    if (!asset || typeof asset !== 'object') return null;
    const role = asset.role || asset.id;
    if (!role) return null;
    return {
      bindingId: role,
      assetRole: role,
      repeatGroupId: asset.repeat_group || asset.repeatGroupId || null,
      payloadPath: asset.repeat_group || asset.repeatGroupId ? `${asset.repeat_group || asset.repeatGroupId}[].${role}` : role,
      required: asset.required !== false,
    };
  }).filter(Boolean);
}

function payloadBindingsFromCanonicalPayload(executionPackage = {}) {
  const payload = object(executionPackage.canonical_payload);
  const out = {};
  for (const key of Object.keys(object(payload.globals))) out[key] = `globals.${key}`;
  for (const key of Object.keys(object(payload.defaults))) out[key] = `defaults.${key}`;
  for (const key of Object.keys(object(payload.assets))) out[key] = `assets.${key}`;
  for (const group of array(payload.repeatGroups)) {
    const sample = group.items?.[0] || {};
    for (const key of Object.keys(object(sample.fields))) out[`${group.id}[].${key}`] = `repeatGroups.${group.id}[].fields.${key}`;
    for (const key of Object.keys(object(sample.assets))) out[`${group.id}[].${key}`] = `repeatGroups.${group.id}[].assets.${key}`;
  }
  return out;
}

function examplePayloadFromExecutionPackage(executionPackage = {}) {
  const payload = object(executionPackage.canonical_payload);
  return {
    ...object(payload.globals),
    ...object(payload.defaults),
    ...object(payload.assets),
  };
}

export function extractWorkflowPackageMetadata(workflowJson = {}, executionPackage = {}) {
  const derivedTabs = tabsFromTargets(workflowJson);
  const derivedRepeatGroups = repeatGroupsFromExecutionPackage(executionPackage);
  const derivedFileBindings = fileBindingsFromAssets(executionPackage);
  const derivedPayloadBindings = payloadBindingsFromCanonicalPayload(executionPackage);
  const derivedExamplePayload = examplePayloadFromExecutionPackage(executionPackage);

  return {
    name: workflowJson.name || executionPackage.name || workflowJson.id || '',
    description: workflowJson.description || executionPackage.description || '',
    outputSchema: object(workflowJson.outputSchema || workflowJson.output_schema || executionPackage.outputSchema || executionPackage.output_schema),
    requiredFiles: array(workflowJson.requiredFiles || workflowJson.required_files || executionPackage.requiredFiles || executionPackage.required_files),
    tabs: array(workflowJson.tabs || executionPackage.tabs).length ? array(workflowJson.tabs || executionPackage.tabs) : derivedTabs,
    auth: array(workflowJson.auth || executionPackage.auth),
    humanApprovalCheckpoints: array(workflowJson.humanApprovalCheckpoints || workflowJson.human_approval_checkpoints || executionPackage.humanApprovalCheckpoints || executionPackage.human_approval_checkpoints || executionPackage.manual_checkpoints),
    recordedSteps: array(workflowJson.steps || workflowJson.recordedSteps || executionPackage.steps || executionPackage.recordedSteps),
    variableBindings: object(workflowJson.variableBindings || workflowJson.variable_bindings || executionPackage.variableBindings || executionPackage.variable_bindings),
    payloadBindings: Object.keys(object(workflowJson.payloadBindings || workflowJson.payload_bindings || executionPackage.payloadBindings || executionPackage.payload_bindings)).length
      ? object(workflowJson.payloadBindings || workflowJson.payload_bindings || executionPackage.payloadBindings || executionPackage.payload_bindings)
      : derivedPayloadBindings,
    examplePayload: Object.keys(object(workflowJson.examplePayload || workflowJson.example_payload || executionPackage.examplePayload || executionPackage.example_payload)).length
      ? object(workflowJson.examplePayload || workflowJson.example_payload || executionPackage.examplePayload || executionPackage.example_payload)
      : derivedExamplePayload,
    fileUploadBindings: array(workflowJson.fileUploadBindings || workflowJson.file_upload_bindings || executionPackage.fileUploadBindings || executionPackage.file_upload_bindings),
    fileBindings: array(workflowJson.fileBindings || workflowJson.file_bindings || executionPackage.fileBindings || executionPackage.file_bindings).length
      ? array(workflowJson.fileBindings || workflowJson.file_bindings || executionPackage.fileBindings || executionPackage.file_bindings)
      : derivedFileBindings,
    repeatGroups: array(workflowJson.repeatGroups || workflowJson.repeat_groups || executionPackage.repeatGroups || executionPackage.repeat_groups).length
      ? array(workflowJson.repeatGroups || workflowJson.repeat_groups || executionPackage.repeatGroups || executionPackage.repeat_groups)
      : derivedRepeatGroups,
    expectedOutputs: array(workflowJson.outputs || workflowJson.expectedOutputs || executionPackage.outputs || executionPackage.expectedOutputs || executionPackage.capture_outputs),
    validationRules: array(workflowJson.validationRules || workflowJson.validation_rules || executionPackage.validationRules || executionPackage.validation_rules),
    replaySettings: object(workflowJson.replaySettings || workflowJson.replay_settings || executionPackage.replaySettings || executionPackage.replay_settings),
    safetyPolicy: object(workflowJson.safetyPolicy || workflowJson.safety_policy || executionPackage.safetyPolicy || executionPackage.safety_policy),
    artifactPolicy: object(workflowJson.artifactPolicy || workflowJson.artifact_policy || executionPackage.artifactPolicy || executionPackage.artifact_policy),
    successAssertions: array(workflowJson.successAssertions || workflowJson.success_assertions || executionPackage.successAssertions || executionPackage.success_assertions),
    failureAssertions: array(workflowJson.failureAssertions || workflowJson.failure_assertions || executionPackage.failureAssertions || executionPackage.failure_assertions),
  };
}
