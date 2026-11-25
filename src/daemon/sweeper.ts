import type { AppContext } from '../core/app.js';
import { RUNTIME_CONSTANTS } from '../core/constants.js';
import type { ConnectionActivity } from './server-connection.js';
import type { SessionRegistry } from './session-registry.js';
import { cleanUpAndExit } from './shutdown.js';

type SweeperInput = {
  ctx: AppContext;
  sessions: SessionRegistry;
  activity: ConnectionActivity;
  exitsWhenIdle: boolean;
};

export function startSweeper(input: SweeperInput): NodeJS.Timeout {
  return setInterval(() => {
    for (const sessionId of input.sessions.onTick().expiredSessionIds) {
      for (const plugin of input.ctx.pluginRegistry.values()) {
        void plugin.closeSession?.(sessionId);
      }
    }
    const idle = input.activity.activeRequests === 0 && Date.now() - input.activity.lastActivityAt >= RUNTIME_CONSTANTS.daemon.idleExitMs;
    if (input.exitsWhenIdle && idle) {
      cleanUpAndExit();
    }
  }, RUNTIME_CONSTANTS.sweeper.tickMs);
}
