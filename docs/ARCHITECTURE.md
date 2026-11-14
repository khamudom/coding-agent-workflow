# Architecture / engineering decisions

## System boundary

This framework owns **workflow orchestration**: local state, approval policy, process invocation, deterministic verification, and evidence capture. The agent CLI owns **language model inference and tool use**. Git owns branch/worktree isolation; the target repo owns build/test policy. We intentionally do not implement another model SDK or a bespoke agent framework.

## Components

| Component | Responsibility | Trust level |
|---|---|---|
| CLI coordinator | Validate transitions, create run IDs, capture timestamps | Trusted local code |
| Spec snapshot | User intent and acceptance criteria | Untrusted data |
| Planner | Repo reconnaissance and plan generation | Probabilistic, read-only |
| Human plan gate | Explicit sign-off of plan snapshot | Human decision |
| Implementer | Scoped edits to a worktree | Probabilistic, write enabled |
| Verifier | Commands from committed config | Deterministic process outcomes, not necessarily complete coverage |
| Reviewer | Fresh-session independent analysis of diff | Probabilistic, read-only, advisory |
| Evidence report | Run/provenance/check history | Local records, not attestation |

## ADR-001: CLI rather than UI/platform service

Start with a small CLI that can be installed once and run against many repos. It minimizes runtime dependencies and makes Git, permissions, and real source changes observable. Add a dashboard only after usage data identifies a specific missing workflow.

## ADR-002: Explicit spec and plan checkpoint

Plan acceptance is manual, separated from model generation. A SHA256 digest of the spec and approved plan discourages accidental plan drift. Changes must result in a new run, not silent substitution.

## ADR-003: A fresh reviewer, not self-approval

Reviewer starts a fresh invocation with original spec, approved plan, tracked Git diff, and untracked file listing. It is deliberately not trusted to make the final merge decision. For stronger independence, select another model via `--provider`.

## ADR-004: Verify with deterministic commands before LLM review

A model claiming “tests pass” is not evidence. Capture exact argv, process status, duration, and log. Bind verification to a content fingerprint and reject review if code changed afterward. Regular CI remains authoritative.

## ADR-005: Safety precedes autonomy

The workflow does not push, merge, deploy, or install dependencies. Verification commands run with `shell: false`. Provider permissions are narrow, but they are not a container or secret boundary.

## ADR-006: No parallel subagents inside a task yet

A planner, implementer, and reviewer are distinct roles executed sequentially. Independent task runs can operate concurrently in separate worktrees. Scheduling 10 concurrent editing agents would introduce merge contention and test attribution problems. Establish success rates and ownership rules before adding it.

## ADR-007: Reference repositories are read-only evidence

A plan may inspect another local Git repository. The reference commit and every cited file hash are recorded. Planning and review can read that repository; execution does not mount it. A change to the reference during planning, execution, or review stops the run. A change to a cited file also stops approval and execution. The implementer receives the captured file text and reimplements the behavior in the target worktree.

## Non-goals for v0.1

Production CI/CD automation; database persistence; distributed queues; cloud execution; autonomous PR/merge; managing authentication; robust secret redaction; arbitrary repo dependency bootstrap; cross-worktree dependency graphs; UI dashboard.
