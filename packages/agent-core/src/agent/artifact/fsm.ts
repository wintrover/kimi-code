export type SubagentFSMState =
  | 'idle'
  | 'exploring'
  | 'committing'
  | 'committed'
  | 'failed';

const VALID_TRANSITIONS: Readonly<Record<SubagentFSMState, ReadonlySet<SubagentFSMState>>> = {
  idle: new Set(['exploring', 'failed']),
  exploring: new Set(['committing', 'failed']),
  committing: new Set(['committed', 'failed']),
  committed: new Set(),
  failed: new Set(),
};

export class SubagentFSM {
  private state: SubagentFSMState = 'idle';

  transition(to: SubagentFSMState): void {
    const allowed = VALID_TRANSITIONS[this.state];
    if (!allowed.has(to)) {
      throw new Error(
        `Invalid FSM transition from "${this.state}" to "${to}"`,
      );
    }
    this.state = to;
  }

  get current(): SubagentFSMState {
    return this.state;
  }
}
