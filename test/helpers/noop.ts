import { vi } from 'vitest';
import type { MockInstance } from 'vitest';

export function createNoop(): () => void {
  return vi.fn<() => void>();
}

export function stubProcessExit(): MockInstance<typeof process.exit> {
  return vi.spyOn(process, 'exit').mockImplementation(vi.fn<typeof process.exit>());
}
