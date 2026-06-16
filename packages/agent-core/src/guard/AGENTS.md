# Guard Module — Formal Verification Gate

This module implements mathematical invariant-based subagent loop prevention.

## Architecture

LLM outputs are treated as **non-deterministic heuristic proposals**. The host system acts as a **deterministic mathematical verifier** through three layers:

1. **`ranking.ts`** — Ranking Function (Loop Variant): weighted distance metric μ(s), monotonicity validation, structural hashing for semantic duplicate detection
2. **`contract.ts`** — Contract Gate (Z3 SMT): formal invariant verification using push/pop scoped solver sessions (Z3 WASM with pure-JS fallback)
3. **`proof.ts`** — Proof Artifact: HMAC-SHA256 signed transition credentials, runtime forgery prevention
4. **`verifier.ts`** — StateVerifier: orchestrates the three layers into a single pipeline
5. **`runtime.ts`** — GuardStateTracker: builds StateVectors from agent activity, manages rollback

## Activation

Gated behind `KIMI_CODE_EXPERIMENTAL_FORMAL_GUARD` (default: off). When enabled, every tool call result passes through the verifier in the `finalizeToolResult` hook.

## Key Design Decisions

- Z3 solver is **stateful per session**: invariants are asserted once, per-transition checks use `push()/pop()` for O(1) amortized verification
- Structural hashing extracts `(key, value)` entity tuples before hashing — catches semantic duplicates that differ only in wording
- Proof artifacts are HMAC-signed with a host-side secret that is never exposed to the agent process
