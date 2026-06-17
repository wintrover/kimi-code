import { describe, it, expect } from 'vitest';
import { greedyBinPackFallback } from '../z3-solver.js';

describe('greedyBinPackFallback', () => {
  it('assigns all tasks to agents', () => {
    const result = greedyBinPackFallback([10, 20, 30], 2, 'test');
    expect(result.assignment).toHaveLength(3);
    expect(result.assignment.every(a => a >= 0 && a < 2)).toBe(true);
    expect(result.solver).toBe('greedy-fallback');
    expect(result.reason).toBe('test');
  });

  it('balances load by sorting descending', () => {
    // W=[10, 20, 30], sorted descending: [30, 20, 10]
    // Agent 0: 30, Agent 1: 20 → then 10 goes to Agent 1
    // Final: Agent 0=30, Agent 1=30
    const result = greedyBinPackFallback([10, 20, 30], 2, '');
    expect(result.T_max).toBe(30);
    expect(result.agentLoads[0]! + result.agentLoads[1]!).toBe(60);
  });

  it('handles single agent', () => {
    const result = greedyBinPackFallback([5, 10, 15], 1, '');
    expect(result.assignment.every(a => a === 0)).toBe(true);
    expect(result.T_max).toBe(30);
  });

  it('handles empty task list', () => {
    const result = greedyBinPackFallback([], 3, '');
    expect(result.assignment).toHaveLength(0);
    expect(result.T_max).toBe(0);
  });

  it('handles more agents than tasks', () => {
    const result = greedyBinPackFallback([10], 5, '');
    expect(result.assignment[0]).toBe(0);
    expect(result.T_max).toBe(10);
  });
});
