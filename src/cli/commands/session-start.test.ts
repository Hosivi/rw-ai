import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveBoardDir } from '../../contract/env.js';
import { err } from '../../core/result.js';
import type { CommandRunner } from '../../engine/exec.js';
import { buildConfig } from '../../engine/git.test-support.js';
import { setupMcpRepo, type McpRepo } from '../../mcp/mcp.test-support.js';
import { unwrap } from '../../core/result.test-support.js';
import { readSessionMarker } from '../../state/marker.js';
import type { CliDeps, CommandResult } from '../command.js';
import { runSessionStart } from './session-start.js';

const NOW = new Date('2026-07-04T12:00:00.000Z');

// A runner that fails exactly as git does outside a repo, so resolveMcpContext
// deterministically returns not-a-repo without touching the real filesystem.
const gitNotARepo: CommandRunner = async () =>
  err({ kind: 'non-zero-exit', output: { stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 } });

// A runner that THROWS rather than returning an err, to prove the outer catch
// fails open too — an unexpected throw must still collapse to the generic offer.
const gitThrows: CommandRunner = async () => {
  throw new Error('boom');
};

// The hook now surfaces its message to the HUMAN via stderr + exit 2 (the same
// channel `rw lane-guard` uses), so tests read the joined stderr lines; stdout
// (`lines`) is empty because Claude Code ignores it when a hook exits 2.
const stderrText = (result: CommandResult): string => (result.stderr ?? []).join('\n');

describe('runSessionStart', () => {
  const run = (
    over: { readonly cwd: string; readonly stdin: string; readonly run?: CommandRunner },
  ): ReturnType<typeof runSessionStart> => {
    const deps: CliDeps & { readonly stdin: string } = {
      cwd: over.cwd,
      homeDir: over.cwd,
      platform: 'linux',
      env: {},
      now: NOW,
      stdin: over.stdin,
      ...(over.run !== undefined ? { run: over.run, runRaw: over.run } : {}),
    };
    return runSessionStart(deps);
  };

  describe('outside a configured repo', () => {
    it('offers rw_bootstrap (never auto-runs) on stderr + exit 2 so the human sees it', async () => {
      const result = await run({ cwd: '/anywhere', stdin: '', run: gitNotARepo });
      // stderr + exit 2 is the only channel Claude Code renders to the human.
      expect(result.exitCode).toBe(2);
      expect(result.lines).toHaveLength(0);
      const ctx = stderrText(result);
      expect(ctx).toContain('rw-ai disponible');
      expect(ctx).toContain('rw_bootstrap');
      expect(ctx).toContain('NO se hace nada automáticamente');
    });

    it('fails open (exit 2, generic offer on stderr) on garbage stdin', async () => {
      const result = await run({ cwd: '/anywhere', stdin: 'not json {', run: gitNotARepo });
      expect(result.exitCode).toBe(2);
    });

    it('fails open (exit 2, generic offer on stderr) on empty stdin', async () => {
      const result = await run({ cwd: '/anywhere', stdin: '', run: gitNotARepo });
      expect(result.exitCode).toBe(2);
    });

    it('fails open to the generic offer on stderr + exit 2 when resolution throws', async () => {
      // The outer catch must swallow any unexpected throw, never break startup.
      const result = await run({ cwd: '/anywhere', stdin: '', run: gitThrows });
      expect(result.exitCode).toBe(2);
      expect(result.lines).toHaveLength(0);
      expect(stderrText(result)).toContain('rw_bootstrap');
    });
  });

  describe('inside a configured repo', () => {
    let mcp: McpRepo;

    beforeEach(async () => {
      mcp = await setupMcpRepo(buildConfig());
    });

    afterEach(async () => {
      await mcp.repo.cleanup();
    });

    it('at the shared root reports the repo configured with N active sessions', async () => {
      const result = await run({ cwd: mcp.repo.root, stdin: '' });
      expect(result.exitCode).toBe(2);
      expect(result.lines).toHaveLength(0);
      const ctx = stderrText(result);
      expect(ctx).toContain('configurado');
      expect(ctx).toContain('2 sesiones');
      expect(ctx).toContain('rw_status');
    });

    it('inside a session worktree names the session, branch and areas + the lane guard', async () => {
      const result = await run({ cwd: mcp.worktreePath('s1'), stdin: '' });
      expect(result.exitCode).toBe(2);
      expect(result.lines).toHaveLength(0);
      const ctx = stderrText(result);
      expect(ctx).toContain('sesión s1');
      expect(ctx).toContain('rw_claim');
      expect(ctx).toContain('lane-guard');
    });

    it('still exits 2 with the configured context on garbage stdin (fail-open)', async () => {
      const result = await run({ cwd: mcp.worktreePath('s1'), stdin: '}{ garbage' });
      expect(result.exitCode).toBe(2);
      expect(stderrText(result)).toContain('sesión s1');
    });

    it('writes a working marker for the session it opened in', async () => {
      await run({ cwd: mcp.worktreePath('s1'), stdin: '' });
      const boardDir = resolveBoardDir(mcp.repo.root, mcp.config);
      const marker = unwrap(await readSessionMarker(boardDir, 's1'));
      expect(marker?.phase).toBe('working');
      expect(marker?.sessionId).toBe('s1');
      expect(marker?.updatedAt).toBe(NOW.toISOString());
    });

    it('does NOT write a marker at the shared root (no current session)', async () => {
      await run({ cwd: mcp.repo.root, stdin: '' });
      const boardDir = resolveBoardDir(mcp.repo.root, mcp.config);
      expect(unwrap(await readSessionMarker(boardDir, 's1'))).toBeNull();
    });
  });
});
