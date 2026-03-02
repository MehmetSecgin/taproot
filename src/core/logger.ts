import pino from 'pino';

export const logger = pino({
  level: process.env.TAPROOT_LOG_LEVEL || 'info',
  redact: {
    paths: ['credentials', '*.password', '*.token', '*.secret'],
    remove: true,
  },
});
