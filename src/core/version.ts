import pkg from '../../package.json' with { type: 'json' };

export const TAPROOT_VERSION: string = pkg.version;
export const TAPROOT_SKILL_VERSION: string = TAPROOT_VERSION;
