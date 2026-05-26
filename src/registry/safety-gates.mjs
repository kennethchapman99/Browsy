// Safety gate enforcement for registry runs.
//
// Gates are evaluated before any browser launch. A blocked gate means the run
// is rejected immediately with processStatus='rejected' and no browser opens.

export const SUPPORTED_MODES = ['preview', 'live', 'discover', 'repair'];

// Check whether a run may proceed given its mode, the workflow version's safety
// policy, and any caller-supplied credentials.
//
// Returns { ok, errors[] }.
export function checkSafetyGates({ workflowVersion, mode, approvalToken }) {
  const errors = [];

  if (!SUPPORTED_MODES.includes(mode)) {
    errors.push(`unsupported mode "${mode}"; must be one of: ${SUPPORTED_MODES.join(', ')}`);
    return { ok: false, errors };
  }

  const supported = workflowVersion.supportedModes || SUPPORTED_MODES;
  if (!supported.includes(mode)) {
    errors.push(`workflow does not support mode "${mode}"; supported: ${supported.join(', ')}`);
    return { ok: false, errors };
  }

  const policy = workflowVersion.safetyPolicy || {};

  if (mode === 'live') {
    if (policy.requiresLiveApproval !== false) {
      if (!approvalToken || typeof approvalToken !== 'string' || !approvalToken.trim()) {
        errors.push('live mode requires a non-empty approvalToken in the request');
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

// Check whether the required session profile is available.
// Returns { ok, errors[] }.
export function checkSessionProfile({ workflowVersion, sessionProfileId, resolveProfile }) {
  const required = workflowVersion.requiredSessionProfile;
  if (!required) return { ok: true, errors: [] };

  const provided = sessionProfileId || null;
  if (!provided) {
    return { ok: false, errors: [`workflow requires sessionProfileId "${required}" but none was provided`] };
  }
  if (provided !== required) {
    return { ok: false, errors: [`workflow requires sessionProfileId "${required}" but got "${provided}"`] };
  }
  if (resolveProfile) {
    const profile = resolveProfile(provided);
    if (!profile) {
      return { ok: false, errors: [`sessionProfileId "${provided}" is not registered`] };
    }
  }
  return { ok: true, errors: [] };
}

// Map a registry mode to the internal workflow-contract mode.
// preview → dry_run, live → live, others → dry_run (safe default).
export function toInternalMode(mode) {
  if (mode === 'live') return 'live';
  return 'dry_run';
}
