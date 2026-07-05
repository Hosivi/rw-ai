import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { err } from '../../core/result.js';
import type { CommandRunner } from '../../engine/exec.js';
import { buildConfig } from '../../engine/git.test-support.js';
import { setupMcpRepo, type McpRepo } from '../../mcp/mcp.test-support.js';
import type { CliDeps } from '../command.js';
import { runSessionStart } from './session-start.js';

const NOW = new Date('2026-07-04T12:00:00.000Z');

// A runner that fails exactly as git does outside a repo, so resolveMcpContext
// deterministically returns not-a-repo without touching the real filesystem.
const gitNotARepo: CommandRunner = async () =>
  err({ kind: 'non-zero-exit', output: { stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 } });

// The hook emits ONE JSON line (the SessionStart contract); parse it back and read
// the injected additionalContext so the tests assert on the surfaced text.
const parseAdditionalContext = (lines: readonly string[]): string => {
  const parsed = JSON.parse(lines[0] ?? '{}') as {
    hookSpecificOutput?: { additionalContext?: string };
  };
  return parsed.hookSpecificOutput?.additionalContext ?? '';
};

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
    it('offers rw_bootstrap (never auto-runs) and exits 0 with the SessionStart shape', async () => {
      const result = await run({ cwd: '/anywhere', stdin: '', run: gitNotARepo });
      expect(result.exitCode).toBe(0);
      // The exact Claude Code SessionStart hook contract.
      const parsed = JSON.parse(result.lines[0] ?? '{}') as {
        hookSpecificOutput?: { hookEventName?: string };
      };
      expect(parsed.hookSpecificOutput?.hookEventName).toBe('SessionStart');
      const ctx = parseAdditionalContext(result.lines);
      expect(ctx).toContain('rw-ai disponible');
      expect(ctx).toContain('rw_bootstrap');
      expect(ctx).toContain('NO se hace nada automáticamente');
    });

    it('fails open (exit 0) on garbage stdin', async () => {
      const result = await run({ cwd: '/anywhere', stdin: 'not json {', run: gitNotARepo });
      expect(result.exitCode).toBe(0);
    });

    it('fails open (exit 0) on empty stdin', async () => {
      const result = await run({ cwd: '/anywhere', stdin: '', run: gitNotARepo });
      expect(result.exitCode).toBe(0);
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
      expect(result.exitCode).toBe(0);
      const ctx = parseAdditionalContext(result.lines);
      expect(ctx).toContain('configurado');
      expect(ctx).toContain('2 sesiones');
      expect(ctx).toContain('rw_status');
    });

    it('inside a session worktree names the session, branch and areas + the lane guard', async () => {
      const result = await run({ cwd: mcp.worktreePath('s1'), stdin: '' });
      expect(result.exitCode).toBe(0);
      const ctx = parseAdditionalContext(result.lines);
      expect(ctx).toContain('sesión s1');
      expect(ctx).toContain('rw_claim');
      expect(ctx).toContain('lane-guard');
    });

    it('still exits 0 with the configured context on garbage stdin (fail-open)', async () => {
      const result = await run({ cwd: mcp.worktreePath('s1'), stdin: '}{ garbage' });
      expect(result.exitCode).toBe(0);
      expect(parseAdditionalContext(result.lines)).toContain('sesión s1');
    });
  });
});
