import { executeRun as executeRunReal, confirmSubmitForRun as confirmSubmitForRunReal } from './run-executor-real.mjs';

export async function executeRun(args) {
  return executeRunReal(args);
}

export async function confirmSubmitForRun(runId, options) {
  return confirmSubmitForRunReal(runId, options);
}
