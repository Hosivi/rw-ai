import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentsConfig } from '../contract/schema.js';
import { unwrap } from '../core/result.test-support.js';
import { buildConfig, runGitOrThrow } from '../engine/git.test-support.js';
import { runCommand } from '../engine/exec.js';
import { resolveMcpContext, type McpContext } from './context.js';
import { setupMcpRepo, type McpRepo } from './mcp.test-support.js';
import {
  handleAddRemote,
  handleBootstrap,
  handleCheck,
  handleClaim,
  handleFinish,
  handleLaneCheck,
  handleRelease,
  handleRoles,
  handleStatus,
  handleWhoami,
  type ToolResult,
} from './tools.js';

const NOW = new Date('2026-07-03T12:00:00.000Z');

// Narrow a ToolResult to its success payload, stripping the `ok` discriminant so
// exact toEqual assertions compare only the data. Throws the engine error on
// failure so a broken handler fails the test that relied on it.
const data = <T>(result: ToolResult<T>): T => {
  if (!result.ok) {
    throw new Error(`expected an ok tool result, got: ${JSON.stringify(result.error)}`);
  }
  const copy: Record<string, unknown> = { ...result };
  delete copy.ok;
  return copy as T;
};

// A 2-session config with distinct lanes and a shared zone so lane-check has a
// real invasion to detect (buildConfig's default '**/*' area matches everything).
const lanedConfig = (): AgentsConfig => {
  const base = buildConfig({ integrationBranch: 'develop' });
  return {
    ...base,
    sharedZones: ['shared/**'],
    sessions: base.sessions.map((session) => ({ ...session, areas: [`src/${session.id}/**`] })),
  };
};

// Commit a single file inside a session's real worktree so analyzeIntegration and
// finishSession see genuine divergence from the integration branch.
const commitInWorktree = async (
  mcp: McpRepo,
  sessionId: string,
  rel: string,
  content: string,
  message: string,
): Promise<void> => {
  const wt = mcp.worktreePath(sessionId);
  const target = path.join(wt, rel);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
  await runGitOrThrow(wt, ['add', '-A']);
  await runGitOrThrow(wt, ['commit', '-m', message]);
};

describe('identity tool handlers', () => {
  let mcp: McpRepo;
  let ctx: McpContext;

  beforeEach(async () => {
    mcp = await setupMcpRepo(buildConfig({ integrationBranch: 'develop' }));
    ctx = unwrap(await resolveMcpContext(mcp.worktreePath('s1')));
  });

  afterEach(async () => {
    await mcp.repo.cleanup();
  });

  it('handleStatus returns the shared root, current session, and the role list', async () => {
    const result = data(await handleStatus(ctx, { now: NOW }));
    expect(result.currentSession?.id).toBe('s1');
    expect(result.sharedRoot).toBe(ctx.sharedRoot);
    // Roles are the active session ids plus the integrator, all free initially.
    expect(result.roles.map((role) => role.role).sort()).toEqual(['integrator', 's1', 's2']);
    expect(result.roles.every((role) => role.status === 'free')).toBe(true);
  });

  it('handleRoles lists every claimable role', async () => {
    const result = data(await handleRoles(ctx, { now: NOW }));
    expect(result.roles.map((role) => role.role).sort()).toEqual(['integrator', 's1', 's2']);
  });

  it('handleWhoami reports no-token when no token is present', async () => {
    expect(data(await handleWhoami(ctx, { now: NOW }))).toEqual({ role: null, reason: 'no-token' });
  });

  it('claim defaults to the current session and whoami then resolves that role', async () => {
    const claim = data(await handleClaim(ctx, {}, { now: NOW }));
    expect(claim.role).toBe('s1');
    expect(claim.token.length).toBeGreaterThanOrEqual(8);

    const who = data(await handleWhoami(ctx, { now: NOW, token: claim.token }));
    expect(who).toMatchObject({ role: 's1' });
  });

  it('claim honors an explicit role and ttlHours', async () => {
    const claim = data(await handleClaim(ctx, { role: 'integrator', ttlHours: 2 }, { now: NOW }));
    expect(claim.role).toBe('integrator');
    if (claim.claim.status !== 'claimed') {
      throw new Error('expected a claimed claim');
    }
    expect(claim.claim.expiresAt).toBe(new Date(NOW.getTime() + 2 * 3_600_000).toISOString());
  });

  it('release frees a role held by the caller token', async () => {
    const claim = data(await handleClaim(ctx, {}, { now: NOW }));
    const released = data(await handleRelease(ctx, {}, { now: NOW, token: claim.token }));
    expect(released).toMatchObject({ role: 's1', released: true });

    const who = data(await handleWhoami(ctx, { now: NOW, token: claim.token }));
    expect(who).toEqual({ role: null, reason: 'no-active-role' });
  });

  it('claim reports no-role when neither an arg nor a current session is present', async () => {
    const rootCtx = unwrap(await resolveMcpContext(mcp.repo.root));
    const result = await handleClaim(rootCtx, {}, { now: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected failure');
    }
    expect(result.error.kind).toBe('no-role');
  });
});

describe('handleLaneCheck', () => {
  let mcp: McpRepo;
  let ctx: McpContext;

  beforeEach(async () => {
    mcp = await setupMcpRepo(lanedConfig());
    ctx = unwrap(await resolveMcpContext(mcp.worktreePath('s1')));
  });

  afterEach(async () => {
    await mcp.repo.cleanup();
  });

  it('allows an in-area path', () => {
    expect(data(handleLaneCheck(ctx, { path: 'src/s1/widget.ts' }))).toEqual({
      path: 'src/s1/widget.ts',
      class: 'in-area',
      allowed: true,
      session: 's1',
    });
  });

  it('allows a shared-zone path', () => {
    expect(data(handleLaneCheck(ctx, { path: 'shared/util.ts' }))).toMatchObject({
      class: 'shared-zone',
      allowed: true,
    });
  });

  it('flags an out-of-area path as an invasion that is not allowed', () => {
    expect(data(handleLaneCheck(ctx, { path: 'src/s2/leak.ts' }))).toMatchObject({
      class: 'invasion',
      allowed: false,
      session: 's1',
    });
  });

  it('reports no-session when the cwd is not inside a session worktree', async () => {
    const rootCtx = unwrap(await resolveMcpContext(mcp.repo.root));
    const result = handleLaneCheck(rootCtx, { path: 'src/s1/a.ts' });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected failure');
    }
    expect(result.error.kind).toBe('no-session');
  });
});

describe('handleCheck', () => {
  let mcp: McpRepo;

  afterEach(async () => {
    await mcp.repo.cleanup();
  });

  it('reports blocking:true when two sessions conflict on the same file', async () => {
    mcp = await setupMcpRepo(buildConfig({ integrationBranch: 'develop' }));
    // Divergent add/add on conflict.ts across s1 and s2 → a simulated merge
    // conflict, which blocks integration even though '**/*' means no invasion.
    await commitInWorktree(mcp, 's1', 'conflict.ts', 'export const v = 1;\n', 'feat: s1');
    await commitInWorktree(mcp, 's2', 'conflict.ts', 'export const v = 2;\n', 'feat: s2');

    const ctx = unwrap(await resolveMcpContext(mcp.worktreePath('s1')));
    const result = data(await handleCheck(ctx, { now: NOW }));
    expect(result.blocking).toBe(true);
    expect(result.analysis.simulatedMerges.some((merge) => merge.status === 'conflict')).toBe(true);
    // The report was written under the shared board.
    expect(result.reportPath).toContain('integration.md');
  });

  it('reports blocking:false for disjoint, in-lane work', async () => {
    mcp = await setupMcpRepo(buildConfig({ integrationBranch: 'develop' }));
    await commitInWorktree(mcp, 's1', 'a.ts', 'export const a = 1;\n', 'feat: s1');
    await commitInWorktree(mcp, 's2', 'b.ts', 'export const b = 1;\n', 'feat: s2');

    const ctx = unwrap(await resolveMcpContext(mcp.worktreePath('s1')));
    const result = data(await handleCheck(ctx, { now: NOW }));
    expect(result.blocking).toBe(false);
  });
});

describe('handleFinish', () => {
  let mcp: McpRepo;

  afterEach(async () => {
    await mcp.repo.cleanup();
  });

  it('integrates the current session and rotates its branch', async () => {
    mcp = await setupMcpRepo(buildConfig({ integrationBranch: 'develop' }));
    await commitInWorktree(mcp, 's1', 'feature.txt', 'session work\n', 'feat: session work');

    const ctx = unwrap(await resolveMcpContext(mcp.worktreePath('s1')));
    const result = data(await handleFinish(ctx, {}, { now: NOW }));
    expect(result).toMatchObject({
      sessionId: 's1',
      oldBranch: 'feat/s1-inicial',
      newBranch: 'feat/s1-2',
      integrationBranch: 'develop',
      oldBranchDeleted: true,
    });
  });

  it('reports no-session when run from the main root', async () => {
    mcp = await setupMcpRepo(buildConfig({ integrationBranch: 'develop' }));
    const rootCtx = unwrap(await resolveMcpContext(mcp.repo.root));
    const result = await handleFinish(rootCtx, {}, { now: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected failure');
    }
    expect(result.error.kind).toBe('no-session');
  });
});

describe('handleAddRemote', () => {
  let mcp: McpRepo;

  beforeEach(async () => {
    mcp = await setupMcpRepo(buildConfig({ integrationBranch: 'develop' }));
  });

  afterEach(async () => {
    await mcp.repo.cleanup();
  });

  it('attaches a remote to the shared root even when called from a session worktree', async () => {
    const ctx = unwrap(await resolveMcpContext(mcp.worktreePath('s1')));
    const result = data(await handleAddRemote(ctx, { url: 'https://example.test/repo.git' }, { now: NOW }));
    expect(result).toEqual({ name: 'origin', url: 'https://example.test/repo.git' });

    // The remote landed on the SHARED root, not the worktree.
    const url = unwrap(
      await runCommand('git', ['remote', 'get-url', 'origin'], { cwd: mcp.repo.root }),
    );
    expect(url.stdout.trim()).toBe('https://example.test/repo.git');
  });
});

describe('handleBootstrap', () => {
  let mcp: McpRepo;

  afterEach(async () => {
    await mcp.repo.cleanup();
  });

  it('reports alreadyConfigured when the integration branch already exists', async () => {
    mcp = await setupMcpRepo(buildConfig({ integrationBranch: 'develop' }));
    const result = data(await handleBootstrap(mcp.repo.root, {}, { now: NOW }));
    expect(result).toMatchObject({ alreadyConfigured: true, gitInitialized: false, committed: false });
  });

  it('refuses with inside-worktree when the cwd is a session worktree', async () => {
    mcp = await setupMcpRepo(buildConfig({ integrationBranch: 'develop' }));
    const result = await handleBootstrap(mcp.worktreePath('s1'), {}, { now: NOW });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('expected failure');
    }
    expect(result.error.kind).toBe('inside-worktree');
  });
});
