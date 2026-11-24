import os from 'node:os';
import path from 'node:path';
import { isNonEmpty } from '../core/text-presence.js';


export function defaultSocketPath(stateRoot?: string): string {
  const root = [stateRoot, process.env.TAPROOT_STATE_ROOT].find((candidate) => isNonEmpty(candidate)) ?? path.join(os.homedir(), '.taproot');
  return path.join(root, 'run', 'taprootd.sock');
}
