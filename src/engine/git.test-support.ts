import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDefaultConfig, type CreateDefaultConfigParams } from '../contract/defaults.js';
import type { AgentsConfig } from '../contract/schema.js';
import { unwrap } from '../core/result.test-support.js';
import { runCommand } from './exec.js';

export type TempRepo = {
  readonly root: string;
  readonly cleanup: () => Promise<void>;
};

// Shared 2-session config for engine specs; override any builder param.
export const buildConfig = (overrides: Partial<CreateDefaultConfigParams> = {}): AgentsConfig =>
  unwrap(
    createDefaultConfig({
      projectName: 'demo',
      stacks: ['node'],
      sessionCount: 2,
      ...overrides,
    }),
  );

// maxRetries/retryDelay: Windows keeps transient locks on just-released files.
export const removeDirRobust = (target: string): Promise<void> =>
  fs.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

// Test-only helper: throwing on failure is intentional — broken repo setup
// must fail the test that relied on it. Exported so specs can drive one-off git
// commands without re-declaring their own runner.
export const runGitOrThrow = async (cwd: string, args: string[]): Promise<void> => {
  const result = await runCommand('git', args, { cwd });
  if (!result.ok) {
    throw new Error(`git ${args.join(' ')} failed: ${JSON.stringify(result.error)}`);
  }
};

export const createTempRepo = async (): Promise<TempRepo> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rw-ai-git-'));
  // realpath because os.tmpdir() can be an 8.3 short path on Windows and a
  // symlink on macOS; git prints real paths, so comparisons need the real root.
  const root = await fs.realpath(dir);
  await runGitOrThrow(root, ['init', '-b', 'main']);
  // Local-only identity and no signing: the suite must not depend on (or be
  // broken by) the developer's global git config.
  await runGitOrThrow(root, ['config', 'user.email', 'tests@rw-ai.invalid']);
  await runGitOrThrow(root, ['config', 'user.name', 'rw-ai tests']);
  await runGitOrThrow(root, ['config', 'commit.gpgsign', 'false']);
  await fs.writeFile(path.join(root, 'README.md'), '# temp repo\n');
  await runGitOrThrow(root, ['add', 'README.md']);
  await runGitOrThrow(root, ['commit', '-m', 'chore: initial commit']);

  const cleanup = async (): Promise<void> => {
    // Detach linked worktrees first (best-effort, results ignored): git holds
    // metadata under .git/worktrees and Windows dislikes removing busy trees.
    const listed = await runCommand('git', ['worktree', 'list', '--porcelain'], { cwd: root });
    if (listed.ok) {
      // Hand-rolled porcelain parsing is DELIBERATE: cleanup must stay
      // independent of parseWorktreeList so a bug in the function under test
      // cannot corrupt the cleanup that follows its failing spec.
      const worktreePaths = listed.value.stdout
        .split(/\r?\n/)
        .filter((line) => line.startsWith('worktree '))
        .map((line) => line.slice('worktree '.length));
      // The first entry is the main worktree (the repo root itself).
      for (const worktreePath of worktreePaths.slice(1)) {
        await runCommand('git', ['worktree', 'remove', '--force', worktreePath], { cwd: root });
      }
    }
    await removeDirRobust(root);
  };

  return { root, cleanup };
};
