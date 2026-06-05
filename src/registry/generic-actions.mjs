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

export function extractWorkflowPackageMetadata(workflowJson = {}, executionPackage = {}) {
  const array = value => Array.isArray(value) ? value : [];
  const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    name: workflowJson.name || executionPackage.name || workflowJson.id || '',
    description: workflowJson.description || executionPackage.description || '',
    outputSchema: object(workflowJson.outputSchema || workflowJson.output_schema || executionPackage.outputSchema || executionPackage.output_schema),
    requiredFiles: array(workflowJson.requiredFiles || workflowJson.required_files || executionPackage.requiredFiles || executionPackage.required_files),
    tabs: array(workflowJson.tabs || executionPackage.tabs),
    auth: array(workflowJson.auth || executionPackage.auth),
    humanApprovalCheckpoints: array(workflowJson.humanApprovalCheckpoints || workflowJson.human_approval_checkpoints || executionPackage.humanApprovalCheckpoints || executionPackage.human_approval_checkpoints || executionPackage.manual_checkpoints),
    recordedSteps: array(workflowJson.steps || workflowJson.recordedSteps || executionPackage.steps || executionPackage.recordedSteps),
    variableBindings: object(workflowJson.variableBindings || workflowJson.variable_bindings || executionPackage.variableBindings || executionPackage.variable_bindings),
    fileUploadBindings: array(workflowJson.fileUploadBindings || workflowJson.file_upload_bindings || executionPackage.fileUploadBindings || executionPackage.file_upload_bindings),
    expectedOutputs: array(workflowJson.outputs || workflowJson.expectedOutputs || executionPackage.outputs || executionPackage.expectedOutputs || executionPackage.capture_outputs),
    validationRules: array(workflowJson.validationRules || workflowJson.validation_rules || executionPackage.validationRules || executionPackage.validation_rules),
    replaySettings: object(workflowJson.replaySettings || workflowJson.replay_settings || executionPackage.replaySettings || executionPackage.replay_settings),
    safetyPolicy: object(workflowJson.safetyPolicy || workflowJson.safety_policy || executionPackage.safetyPolicy || executionPackage.safety_policy),
    artifactPolicy: object(workflowJson.artifactPolicy || workflowJson.artifact_policy || executionPackage.artifactPolicy || executionPackage.artifact_policy),
    successAssertions: array(workflowJson.successAssertions || workflowJson.success_assertions || executionPackage.successAssertions || executionPackage.success_assertions),
    failureAssertions: array(workflowJson.failureAssertions || workflowJson.failure_assertions || executionPackage.failureAssertions || executionPackage.failure_assertions),
    sourceMetadata: object(workflowJson.sourceMetadata || workflowJson.source_metadata || executionPackage.sourceMetadata || executionPackage.source_metadata),
    sourceAppId: workflowJson.sourceAppId || workflowJson.source_app_id || executionPackage.sourceAppId || executionPackage.source_app_id || null,
    sourceWorkflowId: workflowJson.sourceWorkflowId || workflowJson.source_workflow_id || executionPackage.sourceWorkflowId || executionPackage.source_workflow_id || null,
    sourcePayloadSchema: object(workflowJson.sourcePayloadSchema || workflowJson.source_payload_schema || executionPackage.sourcePayloadSchema || executionPackage.source_payload_schema),
    sourceFieldMappings: array(workflowJson.sourceFieldMappings || workflowJson.source_field_mappings || executionPackage.sourceFieldMappings || executionPackage.source_field_mappings),
    tabUrlTemplates: array(workflowJson.tabUrlTemplates || workflowJson.tab_url_templates || executionPackage.tabUrlTemplates || executionPackage.tab_url_templates),
    authProfileRef: workflowJson.authProfileRef || workflowJson.auth_profile_ref || executionPackage.authProfileRef || executionPackage.auth_profile_ref || null,
    completionPolicy: object(workflowJson.completionPolicy || workflowJson.completion_policy || executionPackage.completionPolicy || executionPackage.completion_policy),
    writebackTargets: array(workflowJson.writebackTargets || workflowJson.writeback_targets || executionPackage.writebackTargets || executionPackage.writeback_targets),
  };
}
