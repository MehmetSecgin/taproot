import type { Capability, TelequeryPlugin } from '../types/core.js';

export class PluginRegistry {
  private readonly byName = new Map<string, TelequeryPlugin>();

  register(plugin: TelequeryPlugin): void {
    this.byName.set(plugin.manifest.name, plugin);
  }

  get(name: string): TelequeryPlugin | undefined {
    return this.byName.get(name);
  }

  list(): TelequeryPlugin[] {
    return [...this.byName.values()].sort((a, b) => (b.manifest.priority || 0) - (a.manifest.priority || 0));
  }

  resolveByKind(kind: string): TelequeryPlugin | undefined {
    return this.list().find((p) => p.manifest.name === kind || p.manifest.kind === kind);
  }

  resolveByCapability(capability: Capability): TelequeryPlugin[] {
    return this.list().filter((p) => p.manifest.capabilities.includes(capability));
  }
}
