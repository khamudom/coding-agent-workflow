# Roadmap — what earns the next level of credibility

## Now: v0.1 (included)

Git-isolated stage machine; Markdown specification or prompt; optional read-only reference repository; explicit plan approval; schema version 1 plans (`plan.json` and generated `plan.md`); schema version 1 reviews (`review.json` and generated `review.md`); Codex and Claude Code command adapters; deterministic verification; independent advisory reviewer; artifact trail; offline tests with a mock agent.

## Next: production-worthy harness

1. **Strong isolation:** Per-task container/VM execution, secret stripping, network policy, repository allowlists, time limits, non-root runner.
2. **Run resumption / recovery:** Persist idempotent state transitions; safe retries; no orphan worktrees; clear cancellation.
3. **Evaluation suite:** Fixed cross-repo tasks, held-out acceptance tests, scoring by human reviewers, cost/time metrics.
4. **GitHub/GitLab adapter:** Open PR only after explicit consent, attach evidence and checks, honor branch protection.

## Later: true multi-agent orchestration

5. **Task DAG + ownership:** Planner emits independently testable subtasks, file/area ownership, dependency graph, bounded parallel worktrees.
6. **Conflict-aware integration:** Automated comparison and cherry-pick proposal; human approval for merges; test merged state.
7. **Provider abstraction:** Stable adapter API for local and hosted agents, version pinning, tool-use traces, timeout/budget limits.
8. **Observability:** Per-stage latency, tool calls, tokens, money, failed attempts and prompt/model versions.
9. **Team platform:** Shared policies, access controls, auditable approval identities, CI integration, reusable templates.

**Don't build steps 5–9 until a cross-repo evaluation shows they solve real bottlenecks.**
