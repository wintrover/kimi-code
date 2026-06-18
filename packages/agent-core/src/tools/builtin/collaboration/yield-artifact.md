Yield a structured artifact to the agent's ledger and optionally finalize the subagent.

Use this tool when you have produced the final structured result for your task. The payload is validated against the profile's output schema, written atomically to the workspace ledger, and the turn is stopped.

Parameters:
- `artifact_id`: optional stable id (defaults to "final").
- `payload`: the structured result object.
- `finalize`: when true or omitted, the subagent terminates after committing.

Do not end with a text summary when this tool is available; call YieldArtifact to commit your result.
