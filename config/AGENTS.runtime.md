# Runtime integration migration note

This is a migration reference, not a second injected policy.

Merge the relevant sections of [AGENTS.md](AGENTS.md) into the active host policy once, preserving unrelated user rules and approval boundaries. Do not load both files as parallel instructions or append this note to every session.

Follow [MIGRATION.md](../docs/MIGRATION.md) for rule discovery, host-path checks and rollback. Extension activation does not install host policies.
