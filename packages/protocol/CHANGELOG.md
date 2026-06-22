# @moonshot-ai/protocol

## 0.3.0

### Minor Changes

- [#744](https://github.com/MoonshotAI/kimi-code/pull/744) [`18f299f`](https://github.com/MoonshotAI/kimi-code/commit/18f299fd0b266545a1f7cebae9f58b83b9d9776e) - Add support for legacy SSE MCP servers alongside stdio and streamable HTTP transports.

- [`733c78c`](https://github.com/MoonshotAI/kimi-code/commit/733c78c989fd652bb42d8847639c4bb5932d31ca) - Add immutable execution journal and atomic state capsule for subagent failures, capturing tool history, token metrics, and structured error classification on each subagent completion or failure event.

### Patch Changes

- [`0d3dfc4`](https://github.com/MoonshotAI/kimi-code/commit/0d3dfc4e05e658be5a72ee50eacae6a805b57060) - Fix TypeScript strict mode errors across agent-core and protocol packages.

## 0.2.0

### Minor Changes

- [#612](https://github.com/MoonshotAI/kimi-code/pull/612) [`4603d8a`](https://github.com/MoonshotAI/kimi-code/commit/4603d8ad6e92a303f396f3d79d4e4d212d1c4b14) - Prevent forking sessions during active turns and consolidate wire protocol definitions into a shared internal package.
