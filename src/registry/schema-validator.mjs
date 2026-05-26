// Validate a payload object against a JSON Schema subset.
// Supports: type, required, properties (with type checking), minLength.
export function validatePayload(payload, schema) {
  const errors = [];
  if (!schema || typeof schema !== 'object') return { ok: true, errors };
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, errors: ['payload must be a JSON object'] };
  }

  const required = Array.isArray(schema.required) ? schema.required : [];
  const properties = schema.properties || {};

  for (const field of required) {
    const val = payload[field];
    if (val === undefined || val === null || val === '') {
      errors.push(`missing required field: ${field}`);
    }
  }

  for (const [field, fieldSchema] of Object.entries(properties)) {
    const val = payload[field];
    if (val === undefined || val === null) continue;
    const expectedType = fieldSchema.type;
    if (expectedType) {
      const actualType = Array.isArray(val) ? 'array' : typeof val;
      if (actualType !== expectedType) {
        errors.push(`field ${field}: expected ${expectedType}, got ${actualType}`);
      }
    }
    if (expectedType === 'string' && typeof val === 'string' && fieldSchema.minLength != null) {
      if (val.length < fieldSchema.minLength) {
        errors.push(`field ${field}: must be at least ${fieldSchema.minLength} character(s)`);
      }
    }
    if (expectedType === 'array' && Array.isArray(val) && fieldSchema.minItems != null) {
      if (val.length < fieldSchema.minItems) {
        errors.push(`field ${field}: must have at least ${fieldSchema.minItems} item(s)`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

// Evaluate a single assertion against a run result.
// Assertion shape: { type, field?, op, value? }
//   type: 'captured_output' | 'status' | 'field'
//   op: 'exists' | 'not_exists' | 'equals' | 'not_equals' | 'contains'
export function evaluateAssertion(assertion, result) {
  const { type, field, op, value } = assertion;

  let actual;
  if (type === 'captured_output') {
    const entry = result.captured_outputs?.[field];
    actual = entry?.value ?? entry;
  } else if (type === 'status') {
    actual = result.status;
  } else if (type === 'field') {
    actual = result[field];
  } else {
    return { pass: false, reason: `unknown assertion type: ${type}` };
  }

  switch (op) {
    case 'exists':
      return { pass: actual !== undefined && actual !== null, reason: `${type}.${field} exists` };
    case 'not_exists':
      return { pass: actual === undefined || actual === null, reason: `${type}.${field} not exists` };
    case 'equals':
      return { pass: actual === value, reason: `${type}.${field ?? ''} === ${JSON.stringify(value)} (got ${JSON.stringify(actual)})` };
    case 'not_equals':
      return { pass: actual !== value, reason: `${type}.${field ?? ''} !== ${JSON.stringify(value)} (got ${JSON.stringify(actual)})` };
    case 'contains':
      return { pass: String(actual ?? '').includes(String(value)), reason: `${type}.${field} contains ${JSON.stringify(value)}` };
    default:
      return { pass: false, reason: `unknown op: ${op}` };
  }
}

// Evaluate all assertions. Returns { outcome: 'success'|'failed', failedAssertions }.
export function evaluateAssertions(successAssertions = [], failureAssertions = [], result) {
  const failedSuccess = [];
  for (const a of successAssertions) {
    const { pass, reason } = evaluateAssertion(a, result);
    if (!pass) failedSuccess.push({ assertion: a, reason });
  }
  const triggeredFailure = [];
  for (const a of failureAssertions) {
    const { pass, reason } = evaluateAssertion(a, result);
    if (pass) triggeredFailure.push({ assertion: a, reason });
  }

  const ok = failedSuccess.length === 0 && triggeredFailure.length === 0;
  return {
    outcome: ok ? 'success' : 'failed',
    failedSuccessAssertions: failedSuccess,
    triggeredFailureAssertions: triggeredFailure,
  };
}
