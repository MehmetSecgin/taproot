import type { Capability, TapRootPlugin } from '../types/core.js';

export class PluginRegistry {
  private readonly byName = new Map<string, TapRootPlugin>();

  register(plugin: TapRootPlugin): void {
    this.byName.set(plugin.manifest.name, plugin);
  }

  get(name: string): TapRootPlugin | undefined {
    return this.byName.get(name);
  }

  list(): TapRootPlugin[] {
    return [...this.byName.values()].sort((a, b) => (b.manifest.priority || 0) - (a.manifest.priority || 0));
  }

  resolveByKind(kind: string): TapRootPlugin | undefined {
    return this.list().find((p) => p.manifest.name === kind || p.manifest.kind === kind);
  }

  resolveByCapability(capability: Capability): TapRootPlugin[] {
    return this.list().filter((p) => p.manifest.capabilities.includes(capability));
  }
}
