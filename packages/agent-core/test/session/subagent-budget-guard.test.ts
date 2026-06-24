import { describe, expect, it, vi } from 'vitest';

import { testAgent } from '../agent/harness/agent';
import { SubagentBudgetGuard } from '../../src/session/subagent-budget-guard';

describe('SubagentBudgetGuard', () => {
  it('applies budget to child config when budgetManager provides a value', () => {
    const parent = testAgent();
    parent.configure();

    const child = testAgent();
    child.configure();

    const budgetManager = { getSubagentBudget: vi.fn(() => 30_000) };

    const guard = new SubagentBudgetGuard({
      budgetManager,
      parentAgent: parent.agent,
    });

    guard.enforceBudget('test-child', child.agent);

    expect(child.agent.config.maxTokens).toBe(30_000);
    expect(budgetManager.getSubagentBudget).toHaveBeenCalledOnce();
  });

  it('emits telemetry event when budget is enforced', () => {
    const parent = testAgent();
    parent.configure();

    const child = testAgent();
    child.configure();

    const track = vi.fn();
    const budgetManager = { getSubagentBudget: vi.fn(() => 15_000) };

    const guard = new SubagentBudgetGuard({
      budgetManager,
      telemetry: { track },
      parentAgent: parent.agent,
    });

    guard.enforceBudget('my-child', child.agent);

    expect(track).toHaveBeenCalledWith('subagent.budget.enforced', {
      childLabel: 'my-child',
      requestedTokens: 15_000,
      budgetLimit: 15_000,
      reason: 'exceeded',
    });
  });

  it('appends system reminder to parent context when budget is enforced', () => {
    const parent = testAgent();
    parent.configure();

    const child = testAgent();
    child.configure();

    const budgetManager = { getSubagentBudget: vi.fn(() => 5_000) };

    const guard = new SubagentBudgetGuard({
      budgetManager,
      parentAgent: parent.agent,
    });

    guard.enforceBudget('capped-child', child.agent);

    const history = parent.agent.context.history;
    expect(history.length).toBeGreaterThan(0);
    const lastMessage = history.at(-1);
    expect(lastMessage?.content).toEqual([
      { type: 'text', text: '<system-reminder>\nSubagent capped-child was capped at 5000 tokens.\n</system-reminder>' },
    ]);
    expect(lastMessage?.origin).toEqual({
      kind: 'system_trigger',
      name: 'subagent_budget_enforced',
    });
  });

  it('emits telemetry with unavailable reason when budgetManager is undefined', () => {
    const parent = testAgent();
    parent.configure();

    const child = testAgent();
    child.configure();

    const track = vi.fn();

    const guard = new SubagentBudgetGuard({
      telemetry: { track },
      parentAgent: parent.agent,
    });

    guard.enforceBudget('no-budget-child', child.agent);

    expect(track).toHaveBeenCalledWith('subagent.budget.enforced', {
      childLabel: 'no-budget-child',
      requestedTokens: 0,
      budgetLimit: 0,
      reason: 'unavailable',
    });
  });

  it('does not modify child config when budgetManager is unavailable', () => {
    const parent = testAgent();
    parent.configure();

    const child = testAgent();
    child.configure();

    const guard = new SubagentBudgetGuard({
      parentAgent: parent.agent,
    });

    guard.enforceBudget('skip-child', child.agent);

    expect(child.agent.config.maxTokens).toBeUndefined();
  });

  it('works without telemetry client', () => {
    const parent = testAgent();
    parent.configure();

    const child = testAgent();
    child.configure();

    const budgetManager = { getSubagentBudget: vi.fn(() => 10_000) };

    const guard = new SubagentBudgetGuard({
      budgetManager,
      parentAgent: parent.agent,
    });

    // Should not throw even without telemetry
    guard.enforceBudget('no-telemetry-child', child.agent);

    expect(child.agent.config.maxTokens).toBe(10_000);
  });
});
