import { createNoop } from './noop.js';

export type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

export function createDeferred(): Deferred {
  const gate = { resolve: createNoop() };
  const promise = new Promise<void>((resolve) => {
    gate.resolve = resolve;
  });
  return {
    promise,
    resolve: () => {
      gate.resolve();
    },
  };
}
