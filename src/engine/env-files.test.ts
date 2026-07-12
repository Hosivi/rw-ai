import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { unwrap, unwrapErr } from '../core/result.test-support.js';
import {
  MANAGED_BLOCK_END,
  MANAGED_BLOCK_START,
  renderManagedBlock,
  SESSION_ENV_FILENAME,
  upsertEnvFile,
  writeSessionEnvFiles,
} from './env-files.js';
import { buildConfig, removeDirRobust } from './git.test-support.js';

const ENTRIES = [
  ['RW_SESSION', 's1'],
  ['PORT', '3000'],
] as const satisfies ReadonlyArray<readonly [string, string]>;

const BLOCK = `${MANAGED_BLOCK_START}\nRW_SESSION=s1\nPORT=3000\n${MANAGED_BLOCK_END}`;

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rw-ai-env-'));
});

afterEach(() => removeDirRobust(dir));

const envPath = (): string => path.join(dir, '.env.local');

describe('renderManagedBlock', () => {
  it('renders markers around KEY=value lines with LF endings', () => {
    expect(renderManagedBlock(ENTRIES)).toBe(BLOCK);
  });
});

describe('upsertEnvFile', () => {
  it('creates a missing file with just the block and one trailing newline', async () => {
    const result = unwrap(await upsertEnvFile(envPath(), ENTRIES));
    expect(result.action).toBe('created');
    expect(await fs.readFile(envPath(), 'utf8')).toBe(`${BLOCK}\n`);
  });

  it('reports unchanged (and does not rewrite) when the block is already current', async () => {
    unwrap(await upsertEnvFile(envPath(), ENTRIES));
    const before = await fs.stat(envPath());
    const result = unwrap(await upsertEnvFile(envPath(), ENTRIES));
    expect(result.action).toBe('unchanged');
    // mtime must not move: dev-server watchers restart on any touch.
    const after = await fs.stat(envPath());
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('replaces the block in place without duplicating it on repeat runs', async () => {
    unwrap(await upsertEnvFile(envPath(), ENTRIES));
    const result = unwrap(await upsertEnvFile(envPath(), [['RW_SESSION', 's2']]));
    expect(result.action).toBe('updated');
    const content = await fs.readFile(envPath(), 'utf8');
    expect(content).toBe(`${MANAGED_BLOCK_START}\nRW_SESSION=s2\n${MANAGED_BLOCK_END}\n`);
  });

  it('appends after existing content with a separating blank line', async () => {
    await fs.writeFile(envPath(), 'USER_KEY=untouched\n', 'utf8');
    const result = unwrap(await upsertEnvFile(envPath(), ENTRIES));
    expect(result.action).toBe('updated');
    expect(await fs.readFile(envPath(), 'utf8')).toBe(`USER_KEY=untouched\n\n${BLOCK}\n`);
  });

  it('appends with a separator even when the user content lacks a final newline', async () => {
    await fs.writeFile(envPath(), 'USER_KEY=untouched', 'utf8');
    unwrap(await upsertEnvFile(envPath(), ENTRIES));
    expect(await fs.readFile(envPath(), 'utf8')).toBe(`USER_KEY=untouched\n\n${BLOCK}\n`);
  });

  it('preserves CRLF user lines byte-for-byte and writes block lines with LF', async () => {
    const crlfContent = 'A=1\r\nB=two words\r\n';
    await fs.writeFile(envPath(), crlfContent, 'utf8');
    unwrap(await upsertEnvFile(envPath(), ENTRIES));
    expect(await fs.readFile(envPath(), 'utf8')).toBe(`${crlfContent}\n${BLOCK}\n`);
    // Repeat run with new entries: user CRLF part still intact, block swapped.
    unwrap(await upsertEnvFile(envPath(), [['RW_SESSION', 's9']]));
    expect(await fs.readFile(envPath(), 'utf8')).toBe(
      `${crlfContent}\n${MANAGED_BLOCK_START}\nRW_SESSION=s9\n${MANAGED_BLOCK_END}\n`,
    );
  });

  it('preserves user lines before AND after a block sitting mid-file', async () => {
    await fs.writeFile(envPath(), `BEFORE=1\r\n${BLOCK}\nAFTER=2\n`, 'utf8');
    const result = unwrap(await upsertEnvFile(envPath(), [['PORT', '3001']]));
    expect(result.action).toBe('updated');
    expect(await fs.readFile(envPath(), 'utf8')).toBe(
      `BEFORE=1\r\n${MANAGED_BLOCK_START}\nPORT=3001\n${MANAGED_BLOCK_END}\nAFTER=2\n`,
    );
  });

  it('rejects a file with corrupted markers instead of guessing', async () => {
    await fs.writeFile(envPath(), `${MANAGED_BLOCK_START}\nRW_SESSION=s1\n`, 'utf8');
    const error = unwrapErr(await upsertEnvFile(envPath(), ENTRIES));
    expect(error.message).toContain('corrupted');
  });
});

describe('writeSessionEnvFiles', () => {
  it('writes each file under the shared SESSION_ENV_FILENAME', () => {
    expect(SESSION_ENV_FILENAME).toBe('.env.local');
  });

  it('writes one .env.local per active session into its worktree dir', async () => {
    const config = buildConfig();
    for (const session of config.sessions) {
      await fs.mkdir(path.join(dir, session.worktree), { recursive: true });
    }
    const results = unwrap(await writeSessionEnvFiles(config, dir));
    expect(results).toEqual([
      { sessionId: 's1', filePath: path.join(dir, '.worktrees', 's1', '.env.local'), action: 'created' },
      { sessionId: 's2', filePath: path.join(dir, '.worktrees', 's2', '.env.local'), action: 'created' },
    ]);
    const s1Content = await fs.readFile(path.join(dir, '.worktrees', 's1', '.env.local'), 'utf8');
    expect(s1Content).toContain('RW_SESSION=s1\n');
    expect(s1Content).toContain('PORT=3000\n');
    // Second run is a no-op: same entries, same files.
    const rerun = unwrap(await writeSessionEnvFiles(config, dir));
    expect(rerun.map((entry) => entry.action)).toEqual(['unchanged', 'unchanged']);
  });

  it('skips archived sessions', async () => {
    const config = buildConfig();
    const archived = {
      ...config,
      sessions: config.sessions.map((session) =>
        session.id === 's2' ? { ...session, status: 'archived' as const } : session,
      ),
    };
    await fs.mkdir(path.join(dir, '.worktrees', 's1'), { recursive: true });
    const results = unwrap(await writeSessionEnvFiles(archived, dir));
    expect(results.map((entry) => entry.sessionId)).toEqual(['s1']);
  });

  it('carries the offending sessionId when a worktree dir is missing', async () => {
    const config = buildConfig();
    // Only s1's worktree exists; s2's write must fail and name the session.
    await fs.mkdir(path.join(dir, '.worktrees', 's1'), { recursive: true });
    const error = unwrapErr(await writeSessionEnvFiles(config, dir));
    expect(error.sessionId).toBe('s2');
    expect(error.message).toContain('s2');
  });
});
