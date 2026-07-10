// Pure blast-radius over a call graph (WU-4.2): given the files a session changed,
// find the changed symbols and, transitively, the callers that depend on them.
// The graph is supplied by the CodeGraph port (read.ts) or a fixture; this module
// never touches CodeGraph itself.

export type GraphSymbol = { readonly name: string; readonly file: string };
// caller depends on callee (caller -> callee edge in the call graph).
export type GraphEdge = { readonly caller: string; readonly callee: string };
export type CodeGraph = { readonly symbols: readonly GraphSymbol[]; readonly edges: readonly GraphEdge[] };

export type BlastRadius = {
  readonly changedSymbols: string[];
  // Symbols that (transitively, up to `depth`) call a changed symbol. Excludes the
  // changed symbols themselves.
  readonly affected: string[];
};

export type BlastRadiusOptions = { readonly depth?: number };

const DEFAULT_DEPTH = 1;

export const blastRadius = (
  changedFiles: readonly string[],
  graph: CodeGraph,
  options: BlastRadiusOptions = {},
): BlastRadius => {
  const depth = options.depth ?? DEFAULT_DEPTH;
  const changedFileSet = new Set(changedFiles);
  const changed = new Set(
    graph.symbols.filter((s) => changedFileSet.has(s.file)).map((s) => s.name),
  );

  // BFS outward along reversed edges: from a changed symbol to whoever calls it.
  const affected = new Set<string>();
  let frontier = new Set(changed);
  for (let level = 0; level < depth && frontier.size > 0; level += 1) {
    const next = new Set<string>();
    for (const edge of graph.edges) {
      if (frontier.has(edge.callee) && !affected.has(edge.caller) && !changed.has(edge.caller)) {
        affected.add(edge.caller);
        next.add(edge.caller);
      }
    }
    frontier = next;
  }

  return {
    changedSymbols: [...changed],
    affected: [...affected],
  };
};
