import { describe, expect, it } from 'vitest';
import { renderAsciiDiagram } from './diagram.js';

describe('renderAsciiDiagram', () => {
  it('shows changed symbols and affected callers when CodeGraph is available', () => {
    const lines = renderAsciiDiagram({
      sessionId: 's1',
      changedFiles: ['src/c.ts'],
      blast: { changedSymbols: ['C'], affected: ['A', 'B'] },
    });
    const body = lines.join('\n');
    expect(body).toContain('s1');
    expect(body).toContain('src/c.ts');
    expect(body).toContain('C');
    expect(body).toContain('A');
    expect(body).toContain('B');
  });

  it('degrades to a note + changed files when CodeGraph is unavailable', () => {
    const lines = renderAsciiDiagram({
      sessionId: 's1',
      changedFiles: ['src/c.ts'],
      unavailableReason: 'no CodeGraph index',
    });
    const body = lines.join('\n');
    expect(body).toContain('no CodeGraph index');
    expect(body).toContain('src/c.ts');
    expect(body).not.toContain('Affected');
  });

  it('reports the no-changes case', () => {
    const lines = renderAsciiDiagram({ sessionId: 's1', changedFiles: [] });
    expect(lines.join('\n')).toContain('no changed files');
  });
});
