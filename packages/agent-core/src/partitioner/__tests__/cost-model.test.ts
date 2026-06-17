import { describe, it, expect } from 'vitest';
import { computeWeight, computeWeights } from '../cost-model.js';

describe('computeWeight', () => {
  it('applies NodeCount/100 normalization', () => {
    // NodeCount=500, CC=15, Degree=5 → 1.0×5.0 + 2.0×15 + 1.5×5 = 42.5
    expect(computeWeight(500, 15, 5)).toBeCloseTo(42.5);
  });

  it('returns small weight for typical file (200-800 nodes)', () => {
    // NodeCount=200, CC=5, Degree=3 → 2.0 + 10.0 + 4.5 = 16.5
    expect(computeWeight(200, 5, 3)).toBeCloseTo(16.5);
  });

  it('uses frozen default coefficients', () => {
    // alpha=1.0, beta=2.0, gamma=1.5
    expect(computeWeight(100, 1, 0)).toBeCloseTo(1.0 * 1.0 + 2.0 * 1 + 1.5 * 0);
  });
});

describe('computeWeights', () => {
  it('batch-computes weights for analyses', () => {
    const analyses = [
      { filePath: 'a.nim', metrics: { nodeCount: 500, cyclomaticComplexity: 15, ioDegree: 5, weight: 0, fallback: false }, imports: [] },
      { filePath: 'b.nim', metrics: { nodeCount: 200, cyclomaticComplexity: 5, ioDegree: 3, weight: 0, fallback: false }, imports: [] },
    ];
    const weights = computeWeights(analyses);
    expect(weights[0]).toBeCloseTo(42.5);
    expect(weights[1]).toBeCloseTo(16.5);
  });
});
