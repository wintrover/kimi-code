import { describe, it, expect } from 'vitest';
import { buildUndirectedEdges, buildAdjacencyList, computeIODegrees } from '../dependency-graph.js';

describe('buildUndirectedEdges', () => {
  it('builds deduplicated undirected edges', () => {
    const imports = new Map([
      ['a.nim', new Set(['b.nim', 'c.nim'])],
      ['b.nim', new Set(['c.nim'])],
      ['c.nim', new Set<string>()],
    ]);
    const filePaths = ['a.nim', 'b.nim', 'c.nim'];
    const edges = buildUndirectedEdges(imports, filePaths);
    // a→b: [0,1], a→c: [0,2], b→c: [1,2]
    expect(edges).toHaveLength(3);
    expect(edges).toContainEqual([0, 1]);
    expect(edges).toContainEqual([0, 2]);
    expect(edges).toContainEqual([1, 2]);
  });

  it('deduplicates reverse edges (a→b and b→a)', () => {
    const imports = new Map([
      ['a.nim', new Set(['b.nim'])],
      ['b.nim', new Set(['a.nim'])],
    ]);
    const edges = buildUndirectedEdges(imports, ['a.nim', 'b.nim']);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toEqual([0, 1]);
  });

  it('ignores external imports not in filePaths', () => {
    const imports = new Map([
      ['a.nim', new Set(['std/strutils', 'b.nim'])],
      ['b.nim', new Set<string>()],
    ]);
    const edges = buildUndirectedEdges(imports, ['a.nim', 'b.nim']);
    expect(edges).toHaveLength(1);
  });
});

describe('buildAdjacencyList', () => {
  it('builds bidirectional adjacency', () => {
    const adj = buildAdjacencyList([[0, 1], [1, 2]], 3);
    expect(adj.get(0)).toEqual(new Set([1]));
    expect(adj.get(1)).toEqual(new Set([0, 2]));
    expect(adj.get(2)).toEqual(new Set([1]));
  });
});

describe('computeIODegrees', () => {
  it('counts import degree per file', () => {
    const analyses = [
      { filePath: 'a.nim', metrics: {} as any, imports: ['b.nim', 'c.nim'] },
      { filePath: 'b.nim', metrics: {} as any, imports: ['c.nim'] },
      { filePath: 'c.nim', metrics: {} as any, imports: [] },
    ];
    const degrees = computeIODegrees(analyses);
    expect(degrees[0]).toBe(2); // a imports b,c
    expect(degrees[1]).toBe(2); // b imported by a, imports c
    expect(degrees[2]).toBe(2); // c imported by a,b
  });
});
