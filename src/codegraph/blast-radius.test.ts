import { describe, expect, it } from 'vitest';
import { blastRadius, type CodeGraph } from './blast-radius.js';

// A calls B, B calls C; A in a.ts, B in b.ts, C in c.ts.
const graph: CodeGraph = {
  symbols: [
    { name: 'A', file: 'src/a.ts' },
    { name: 'B', file: 'src/b.ts' },
    { name: 'C', file: 'src/c.ts' },
    { name: 'Unrelated', file: 'src/z.ts' },
  ],
  edges: [
    { caller: 'A', callee: 'B' },
    { caller: 'B', callee: 'C' },
  ],
};

describe('blastRadius', () => {
  it('maps changed files to their symbols', () => {
    const result = blastRadius(['src/c.ts'], graph);
    expect(result.changedSymbols).toEqual(['C']);
  });

  it('finds direct callers at depth 1', () => {
    const result = blastRadius(['src/c.ts'], graph, { depth: 1 });
    expect(result.affected.sort()).toEqual(['B']);
  });

  it('propagates transitively with a higher depth', () => {
    const result = blastRadius(['src/c.ts'], graph, { depth: 5 });
    expect(result.affected.sort()).toEqual(['A', 'B']);
  });

  it('returns empty when the changed file has no symbols', () => {
    const result = blastRadius(['src/nothing.ts'], graph);
    expect(result.changedSymbols).toEqual([]);
    expect(result.affected).toEqual([]);
  });

  it('does not include the changed symbols themselves in affected', () => {
    const result = blastRadius(['src/b.ts'], graph, { depth: 5 });
    expect(result.affected).not.toContain('B');
    expect(result.affected.sort()).toEqual(['A']);
  });

  it('handles a symbol changed and called by two others without duplicates', () => {
    const diamond: CodeGraph = {
      symbols: [
        { name: 'Root', file: 'r.ts' },
        { name: 'L', file: 'l.ts' },
        { name: 'R', file: 'rr.ts' },
        { name: 'Leaf', file: 'leaf.ts' },
      ],
      edges: [
        { caller: 'Root', callee: 'L' },
        { caller: 'Root', callee: 'R' },
        { caller: 'L', callee: 'Leaf' },
        { caller: 'R', callee: 'Leaf' },
      ],
    };
    const result = blastRadius(['leaf.ts'], diamond, { depth: 5 });
    expect(result.affected.sort()).toEqual(['L', 'R', 'Root']);
  });
});
