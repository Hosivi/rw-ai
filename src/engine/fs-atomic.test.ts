import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { unwrap } from '../core/result.test-support.js';
import { writeFileAtomic } from './fs-atomic.js';
import { removeDirRobust } from './git.test-support.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rw-ai-atomic-')));
});

afterEach(() => removeDirRobust(dir));

describe('writeFileAtomic', () => {
  it('writes new content byte-for-byte', async () => {
    const target = path.join(dir, 'out.txt');
    unwrap(await writeFileAtomic(target, 'hello\n'));
    expect(await fs.readFile(target, 'utf8')).toBe('hello\n');
  });

  it('overwrites an existing file in place', async () => {
    const target = path.join(dir, 'out.txt');
    unwrap(await writeFileAtomic(target, 'first'));
    unwrap(await writeFileAtomic(target, 'second'));
    expect(await fs.readFile(target, 'utf8')).toBe('second');
  });

  it('leaves no temp files behind after a successful write', async () => {
    const target = path.join(dir, 'out.txt');
    unwrap(await writeFileAtomic(target, 'x'));
    expect(await fs.readdir(dir)).toEqual(['out.txt']);
  });
});
