import type { AppContext } from '../core/app.js';

export type VerboseLog = (message: string) => void;

export function createVerboseLog(ctx: AppContext): VerboseLog {
  return (message) => {
    if (ctx.verbose) {
      process.stderr.write(`${JSON.stringify({ verbose: message })}\n`);
    }
  };
}
