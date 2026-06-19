Set, append, or delete an environment variable in the agent's environment store.

This is a **declarative** alternative to using `export` in shell commands. Environment
variables set this way are automatically injected into all future shell commands.

Actions:
- `set`: Overwrite the variable with the given value
- `append`: Add to the existing value using ":" as separator (useful for PATH)
- `delete`: Remove the variable

Use `ListEnv` to see all current environment variables and their values.
Use `GetEnv` to check a single variable.
