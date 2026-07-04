import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectBaseBranch, detectProject, detectProjectName, detectStacks } from './detect.js';
import { createGit } from './git.js';
import { createTempRepo, removeDirRobust, runGitOrThrow, type TempRepo } from './git.test-support.js';

let dir: string;

beforeEach(async () => {
  // realpath: os.tmpdir() can be an 8.3 short path on Windows / a symlink on
  // macOS, and basename fallback assertions must compare the real path.
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rw-ai-detect-')));
});

afterEach(() => removeDirRobust(dir));

const write = (name: string, content: string): Promise<void> =>
  fs.writeFile(path.join(dir, name), content, 'utf8');

describe('detectStacks', () => {
  it('detects node from a package.json', async () => {
    await write('package.json', '{"name":"x"}');
    expect(await detectStacks(dir)).toEqual(['node']);
  });

  it('detects dotnet from a .csproj at the root', async () => {
    await write('App.csproj', '<Project></Project>');
    expect(await detectStacks(dir)).toEqual(['dotnet']);
  });

  it('detects dotnet from a .sln at the root', async () => {
    await write('App.sln', '');
    expect(await detectStacks(dir)).toEqual(['dotnet']);
  });

  it('detects android from build.gradle', async () => {
    await write('build.gradle', '');
    expect(await detectStacks(dir)).toEqual(['android']);
  });

  it('detects android from settings.gradle and build.gradle.kts too', async () => {
    await write('settings.gradle', '');
    expect(await detectStacks(dir)).toEqual(['android']);
    await fs.rm(path.join(dir, 'settings.gradle'));
    await write('build.gradle.kts', '');
    expect(await detectStacks(dir)).toEqual(['android']);
  });

  it('returns every detected stack in the fixed [node, android, dotnet] order', async () => {
    await write('App.csproj', '<Project></Project>');
    await write('build.gradle', '');
    await write('package.json', '{}');
    expect(await detectStacks(dir)).toEqual(['node', 'android', 'dotnet']);
  });

  it('returns [] when no marker is present', async () => {
    expect(await detectStacks(dir)).toEqual([]);
  });
});

describe('detectProjectName', () => {
  it('reads name from package.json when present and non-empty', async () => {
    await write('package.json', '{"name":"my-app"}');
    expect(await detectProjectName(dir)).toBe('my-app');
  });

  it('falls back to the directory basename when package.json has no usable name', async () => {
    await write('package.json', '{"name":"   "}');
    expect(await detectProjectName(dir)).toBe(path.basename(dir));
  });

  it('falls back to the directory basename when there is no package.json', async () => {
    expect(await detectProjectName(dir)).toBe(path.basename(dir));
  });

  it('never throws on invalid JSON', async () => {
    await write('package.json', '{ not json');
    expect(await detectProjectName(dir)).toBe(path.basename(dir));
  });
});

describe('detectBaseBranch', () => {
  let repo: TempRepo;

  afterEach(async () => {
    await repo.cleanup();
  });

  it("returns 'main' when the repo has a main branch", async () => {
    repo = await createTempRepo();
    expect(await detectBaseBranch(createGit(repo.root))).toBe('main');
  });

  it("returns 'master' when main is absent but master exists", async () => {
    repo = await createTempRepo();
    await runGitOrThrow(repo.root, ['branch', '-m', 'main', 'master']);
    expect(await detectBaseBranch(createGit(repo.root))).toBe('master');
  });

  it('falls back to the current branch when neither main nor master exists', async () => {
    repo = await createTempRepo();
    await runGitOrThrow(repo.root, ['branch', '-m', 'main', 'trunk']);
    expect(await detectBaseBranch(createGit(repo.root))).toBe('trunk');
  });
});

describe('detectProject', () => {
  it('runs stacks, name and db detection together', async () => {
    await write('package.json', '{"name":"combo"}');
    await write(
      'docker-compose.yml',
      ['services:', '  db:', '    image: postgres:16', ''].join('\n'),
    );
    const detection = await detectProject(dir);
    expect(detection.stacks).toEqual(['node']);
    expect(detection.projectName).toBe('combo');
    expect(detection.db.strategy).toBe('docker');
  });

  it('degrades db detection to strategy none when nothing points at a database', async () => {
    await write('package.json', '{"name":"solo"}');
    const detection = await detectProject(dir);
    expect(detection.db.strategy).toBe('none');
  });
});
