---
"@moonshot-ai/kosong": patch
"@moonshot-ai/agent-core": patch
"@moonshot-ai/kimi-code": patch
---

Fix misclassification of SSE stream drop errors (undici "terminated") as non-retryable, and add transport-level error pattern deduplication across providers.
