import type { TapRootPlugin } from '../../types/plugin.js';
import { checkGrpcChannel } from './doctor.js';
import { executeGrpc } from './execute.js';

export const grpcPlugin: TapRootPlugin = {
  manifest: {
    name: 'grpc',
    capabilities: ['doctor', 'executeRead'],
  },

  doctor: checkGrpcChannel,

  execute: executeGrpc,
};
