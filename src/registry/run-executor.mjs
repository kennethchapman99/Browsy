import { executeRun as executeRunReal } from './run-executor-real.mjs';

export async function executeRun(args) {
  return executeRunReal(args);
}
