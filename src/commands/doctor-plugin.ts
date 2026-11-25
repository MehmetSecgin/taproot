import type { TapRootPlugin } from '../types/plugin.js';

export type DoctorCapablePlugin = TapRootPlugin & Required<Pick<TapRootPlugin, 'doctor'>>;

export function isDoctorCapable(plugin: TapRootPlugin | undefined): plugin is DoctorCapablePlugin {
  return plugin?.doctor !== undefined;
}
