import { describe, expect, it } from 'vitest';
import { daemonAddress } from './address.js';

describe('daemonAddress', () => {
  it('uses a Windows named pipe on win32', () => {
    const addr = daemonAddress('E:\\repos\\demo', 'win32', '/tmp');
    expect(addr.startsWith('\\\\.\\pipe\\rw-ai-')).toBe(true);
  });

  it('uses a unix socket path under the runtime dir on linux', () => {
    const addr = daemonAddress('/home/u/demo', 'linux', '/run/user/1000');
    expect(addr.startsWith('/run/user/1000/rw-ai-')).toBe(true);
    expect(addr.endsWith('.sock')).toBe(true);
  });

  it('differs by repo root', () => {
    expect(daemonAddress('/a', 'linux', '/tmp')).not.toBe(daemonAddress('/b', 'linux', '/tmp'));
  });

  it('is stable across Windows drive-casing and slash direction (same repo → same address)', () => {
    expect(daemonAddress('E:\\repos\\demo', 'win32', '/tmp')).toBe(
      daemonAddress('e:/repos/demo', 'win32', '/tmp'),
    );
  });

  it('selects a different shape per platform for the same repo', () => {
    const win = daemonAddress('/x/y', 'win32', '/tmp');
    const nix = daemonAddress('/x/y', 'linux', '/tmp');
    expect(win.startsWith('\\\\.\\pipe\\')).toBe(true);
    expect(nix.startsWith('/tmp')).toBe(true);
    expect(win).not.toBe(nix);
  });
});
