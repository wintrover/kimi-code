Launch a subagent to handle a task. The subagent runs as a same-process loop instance with its own context and wire file.

Writing the prompt:
- The subagent starts with zero context — it has not seen this conversation. Brief it like a colleague who just walked into the room: state the goal, list what you already know, hand over the specifics.
- Lookups (read this file, run that test): put the exact path or command in the prompt. The subagent should not have to search for things you already know.
- Investigations (figure out X, find why Y): give the question, not prescribed steps — fixed steps become dead weight when the premise is wrong.
- Do not delegate understanding. If the task hinges on a file path or line number, find it yourself first and write it into the prompt.

Usage notes:
- When the task continues earlier work a subagent already did, prefer resuming that agent (pass its `resume` id) over spawning a fresh instance — the resumed agent keeps its prior context.
- A subagent's result is only visible to you, not to the user. When the user needs to see what a subagent produced, summarize the relevant parts yourself in your own reply.
- Subagents use a fixed 30-minute timeout. If one times out, resume the same agent instead of starting over.

Output modes:
- `output_mode='text'` (default): the subagent returns a natural-language summary, the same behavior as before.
- `output_mode='artifact'`: the subagent must finish by calling `YieldArtifact(payload=..., finalize=true)`. Its payload is written atomically to an isolated workspace ledger and returned to you as structured JSON. The subagent gets its own workspace under `<session>/subagents/<agent_id>/`; file operations do not affect the parent working directory. If the subagent finishes without calling `YieldArtifact`, the call fails deterministically so you can retry or switch to text mode.

When NOT to use Agent: skip delegation for trivial work you can do directly — reading a file whose path you already know, searching a small known set of files, or any task that takes only a step or two. Delegation has a context handoff cost; it pays off only when the task is substantial enough to outweigh it.

Once a subagent is running, leave that scope to it: do not redo its searches or reads in parallel, and do not abandon it midway and finish the job manually. Both undo the context savings the delegation was meant to buy.
