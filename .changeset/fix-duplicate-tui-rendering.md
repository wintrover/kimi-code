---
"@moonshot-ai/kimi-code": patch
---

Fix duplicate TUI rendering during streaming by auto-flushing dirty buffers at the render transaction commit boundary.
