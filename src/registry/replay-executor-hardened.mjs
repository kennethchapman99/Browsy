import { runReplay as baseRunReplay } from './replay-executor.mjs';

export async function runReplay(args) {
  return baseRunReplay({
    ...args,
    options: {
      ...(args.options || {}),
      timeoutMs: Math.max(Number(args.options?.timeoutMs || 0), 30000),
      settleMs: Math.max(Number(args.options?.settleMs || 0), 4000),
      stopOnStepFailure: args.options?.stopOnStepFailure ?? true,
    },
  });
}
