import type { Agent } from '#/agent';
import type { TelemetryClient } from '#/telemetry';

export interface SubagentBudgetGuardOptions {
  readonly budgetManager?: { getSubagentBudget(): number };
  readonly telemetry?: TelemetryClient;
  readonly parentAgent: Agent;
}

export class SubagentBudgetGuard {
  constructor(private readonly options: SubagentBudgetGuardOptions) {}

  enforceBudget(childLabel: string, child: Agent): void {
    const budget = this.options.budgetManager?.getSubagentBudget();

    if (budget === undefined) {
      // No budget available — log and skip
      this.options.telemetry?.track('subagent.budget.enforced', {
        childLabel,
        requestedTokens: 0,
        budgetLimit: 0,
        reason: 'unavailable',
      });
      return;
    }

    // Apply budget
    child.config.update({ maxTokens: budget });

    // Observability
    this.options.telemetry?.track('subagent.budget.enforced', {
      childLabel,
      requestedTokens: budget,
      budgetLimit: budget,
      reason: 'exceeded',
    });

    this.options.parentAgent.context.appendSystemReminder(
      `Subagent ${childLabel} was capped at ${budget} tokens.`,
      { kind: 'system_trigger', name: 'subagent_budget_enforced' },
    );

    this.options.parentAgent.log.warn('Subagent budget enforced', {
      childLabel,
      budgetLimit: budget,
    });
  }
}
