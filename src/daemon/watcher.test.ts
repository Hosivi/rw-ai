import { describe, expect, it } from 'vitest';
import { createDebouncer } from './watcher.js';

const makeTimers = () => {
  let cb: (() => void) | null = null;
  return {
    timers: {
      set: (fn: () => void) => {
        cb = fn;
        return 1 as unknown;
      },
      clear: () => {
        cb = null;
      },
    },
    fire: () => cb?.(),
    armed: () => cb !== null,
  };
};

describe('createDebouncer', () => {
  it('coalesces a burst of triggers into a single call', () => {
    const t = makeTimers();
    let calls = 0;
    const debounced = createDebouncer(() => (calls += 1), 100, t.timers);
    debounced();
    debounced();
    debounced();
    expect(calls).toBe(0); // nothing fires until the window elapses
    t.fire();
    expect(calls).toBe(1);
  });

  it('fires again for a trigger after the previous window closed', () => {
    const t = makeTimers();
    let calls = 0;
    const debounced = createDebouncer(() => (calls += 1), 100, t.timers);
    debounced();
    t.fire();
    debounced();
    t.fire();
    expect(calls).toBe(2);
  });

  it('cancel() drops a pending call', () => {
    const t = makeTimers();
    let calls = 0;
    const debounced = createDebouncer(() => (calls += 1), 100, t.timers);
    debounced();
    debounced.cancel();
    expect(t.armed()).toBe(false);
    t.fire();
    expect(calls).toBe(0);
  });
});
