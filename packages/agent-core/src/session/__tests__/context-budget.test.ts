import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ContextBudgetManager, BudgetAction, DEFAULT_BUDGET_CONFIG } from '#/session/context-budget';
import { TurnBoundary } from '#/session/turn-boundary';
import { MemoryCheckpointer } from '#/session/checkpoint';
import { buildRecoveryContext } from '#/session/hydrator';

describe('ContextBudgetManager', () => {
  let manager: ContextBudgetManager;

  beforeEach(() => {
    manager = new ContextBudgetManager();
  });

  describe('checkBudget', () => {
    it('returns ALLOW when under softLimit', () => {
      const result = manager.checkBudget(50_000);
      expect(result.action).toBe(BudgetAction.ALLOW);
      expect(result.message).toBeUndefined();
    });

    it('returns WARN when above softLimit but under 90%', () => {
      // 70_000 with 5% buffer = 73_500 → over softLimit (70k) but under 90k (90% of 100k)
      const result = manager.checkBudget(70_000);
      expect(result.action).toBe(BudgetAction.WARN);
      expect(result.message).toContain('Approaching limits');
    });

    it('returns SOFT_COMPACT when above 90% but under 95%', () => {
      // 87_000 * 1.05 = 91_350 → over 90k (90%) but under 95k (95%)
      const result = manager.checkBudget(87_000);
      expect(result.action).toBe(BudgetAction.SOFT_COMPACT);
      expect(result.message).toContain('Soft compaction recommended');
    });

    it('returns EMERGENCY_CLEAVE when above 95%', () => {
      // 92_000 * 1.05 = 96_600 → over 95k (95%)
      const result = manager.checkBudget(92_000);
      expect(result.action).toBe(BudgetAction.EMERGENCY_CLEAVE);
      expect(result.message).toContain('Emergency');
    });

    it('returns HARD_STOP when at or above hardLimit', () => {
      // 96_000 * 1.05 = 100_800 → over 100k
      const result = manager.checkBudget(96_000);
      expect(result.action).toBe(BudgetAction.HARD_STOP);
      expect(result.message).toContain('Hard token limit reached');
    });

    it('applies 5% token buffer by default', () => {
      // 90_000 * 1.05 = 94_500 < 95_000 → SOFT_COMPACT
      const result = manager.checkBudget(90_000);
      expect(result.usedTokens).toBe(94_500);
      expect(result.action).toBe(BudgetAction.SOFT_COMPACT);
    });

    it('skips buffer when bufferApplied=true', () => {
      // Without buffer: 94_000 < 95_000 → SOFT_COMPACT
      const result = manager.checkBudget(94_000, true);
      expect(result.usedTokens).toBe(94_000);
      expect(result.action).toBe(BudgetAction.SOFT_COMPACT);
    });

    it('tracks lastAction', () => {
      manager.checkBudget(50_000);
      expect(manager.getLastAction()).toBe(BudgetAction.ALLOW);
      manager.checkBudget(92_000);
      expect(manager.getLastAction()).toBe(BudgetAction.EMERGENCY_CLEAVE);
    });

    it('respects custom config', () => {
      const custom = new ContextBudgetManager({ hardLimit: 200_000, softLimit: 100_000 });
      // 100_000 * 1.05 = 105_000 > softLimit (100k) → WARN
      const result = custom.checkBudget(100_000);
      expect(result.action).toBe(BudgetAction.WARN);
      expect(result.limit).toBe(200_000);
    });
  });

  describe('emergencyCleave', () => {
    it('saves checkpoint and returns recovery context', async () => {
      const boundary = new TurnBoundary();
      boundary.start();
      boundary.state.transition('planning');
      boundary.state.transition('executing');

      const checkpointStore = new MemoryCheckpointer();
      const ctx = await manager.emergencyCleave(
        boundary,
        checkpointStore,
        'agent-0',
        'Fix the bug',
        ['Edit file.ts', 'Run tests'],
      );

      expect(ctx.goal).toBe('Fix the bug');
      expect(ctx.pendingSteps).toEqual(['Edit file.ts', 'Run tests']);
      expect(boundary.state.getPhase()).toBe('emergency_cleaving');
      expect(manager.getEmergencyCleaveCount()).toBe(1);

      const saved = await checkpointStore.load('agent-0');
      expect(saved).toBeDefined();
      expect(saved!.agentId).toBe('agent-0');
    });

    it('generates idempotency guide when pending steps exist', async () => {
      const boundary = new TurnBoundary();
      boundary.start();
      boundary.state.transition('executing');

      const checkpointStore = new MemoryCheckpointer();
      const ctx = await manager.emergencyCleave(
        boundary,
        checkpointStore,
        'agent-0',
        'Fix bug',
        ['Write file.ts'],
        'tool-call-1',
      );

      expect(ctx.idempotencyGuide).toBeDefined();
      expect(ctx.idempotencyGuide).toContain('[VERIFY]');
    });
  });

  describe('getInjections', () => {
    it('returns both idempotency and recovery injections', async () => {
      const boundary = new TurnBoundary();
      boundary.start();
      boundary.state.transition('executing');

      const checkpointStore = new MemoryCheckpointer();
      const ctx = await manager.emergencyCleave(
        boundary,
        checkpointStore,
        'agent-0',
        'Fix bug',
        ['Write file.ts'],
        'tool-call-1',
      );

      const injections = manager.getInjections(ctx);
      expect(injections.idempotency).toBeDefined();
      expect(injections.idempotency).toContain('[VERIFY]');
      expect(injections.recovery).toBeDefined();
      expect(injections.recovery).toContain('Compaction Recovery');
    });

    it('returns only recovery when no side-effect interruption', () => {
      const ctx = buildRecoveryContext({
        turnState: { phase: 'executing', turnId: 1, history: [] },
        agentId: 'agent-0',
        turnId: 1,
        pendingSteps: [],
        goal: 'Do something',
        sideEffectState: 'none',
        timestamp: Date.now(),
      });
      const injections = manager.getInjections(ctx);
      expect(injections.idempotency).toBeUndefined();
      expect(injections.recovery).toBeDefined();
    });
  });

  describe('getSubagentBudget', () => {
    it('returns 30% of hardLimit by default', () => {
      expect(manager.getSubagentBudget()).toBe(30_000);
    });

    it('respects custom subagentBudgetRatio', () => {
      const custom = new ContextBudgetManager({ subagentBudgetRatio: 0.5 });
      expect(custom.getSubagentBudget()).toBe(50_000);
    });
  });

  describe('updateConfig', () => {
    it('merges partial config', () => {
      manager.updateConfig({ tokenBufferRatio: 0.02 });
      expect(manager.getConfig().tokenBufferRatio).toBe(0.02);
      // Other values unchanged
      expect(manager.getConfig().hardLimit).toBe(DEFAULT_BUDGET_CONFIG.hardLimit);
    });
  });
});
