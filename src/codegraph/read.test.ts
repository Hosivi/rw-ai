import { describe, expect, it } from 'vitest';
import { ok } from '../core/result.js';
import type { CommandRunner } from '../engine/exec.js';
import { queryCodeGraph } from './read.js';

const okRun = (stdout: string): CommandRunner => async () => ok({ stdout, stderr: '', exitCode: 0 });
const failRun: CommandRunner = async () => ok({ stdout: '', stderr: 'boom', exitCode: 1 });

const present = async () => true;
const absent = async () => false;

const graphJson = JSON.stringify({
  symbols: [{ name: 'A', file: 'a.ts' }],
  edges: [{ caller: 'A', callee: 'B' }],
});

describe('queryCodeGraph', () => {
  it('reports unavailable when there is no .codegraph index', async () => {
    const result = await queryCodeGraph('/repo', ['a.ts'], { access: absent, runRaw: okRun(graphJson) });
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.reason).toMatch(/index/i);
    }
  });

  it('returns the parsed graph when the CLI answers with the expected shape', async () => {
    const result = await queryCodeGraph('/repo', ['a.ts'], { access: present, runRaw: okRun(graphJson) });
    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.graph.symbols[0]?.name).toBe('A');
      expect(result.graph.edges[0]?.callee).toBe('B');
    }
  });

  it('degrades to unavailable when the CLI fails', async () => {
    const result = await queryCodeGraph('/repo', ['a.ts'], { access: present, runRaw: failRun });
    expect(result.available).toBe(false);
  });

  it('degrades to unavailable when the CLI output is not the expected shape', async () => {
    const result = await queryCodeGraph('/repo', ['a.ts'], { access: present, runRaw: okRun('not json at all') });
    expect(result.available).toBe(false);
  });
});
