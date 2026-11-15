# Code Agent Workflow

Code Agent Workflow (`caw`) is a local command-line harness for coding agents. It runs Codex CLI or Claude Code CLI through a fixed engineering workflow: plan, human approval, isolated implementation, deterministic verification, independent review, and a local evidence report.

The agents still do the coding. `caw` controls the order, permissions, and records. It is useful when a normal agent session is too informal for the change you want to make: a risky edit, a repeatable task, or a port from a prototype repository into a production repository.

This is v0.1. It is a local tool, not a hosted platform. The test suite drives a mock agent so the workflow can be checked without a model. A live Codex or Claude run needs that provider's CLI installed and authenticated on your machine.

## What a run does

1. You supply a Markdown specification, or a prompt that `caw` saves as one.
2. A read-only planner inspects the repository and writes `plan.md`.
3. You read the plan and approve that exact snapshot.
4. The implementer edits an isolated Git branch and worktree.
5. The verification commands in `.code-agent-workflow.json` must pass.
6. A fresh read-only reviewer reports findings. Its verdict does not approve the change.
7. You review the diff and use your normal pull request, CI, and merge process.

`caw` does not push, commit, merge, deploy, or install dependencies.

## Two ways to start

Use one repository when the task lives entirely there:

```bash
caw plan specs/example-feature.md --provider codex
```

```bash
caw plan --prompt "Add a login form and cover success and failure with tests." --provider codex
```

Add `--reference` only when the planner needs to read another local Git repository, such as a prototype:

```bash
caw plan \
  --prompt "Reimplement the quest behavior from the prototype using this repository's patterns. Do not copy the prototype code." \
  --reference ../prototype \
  --provider codex
```

The reference repository is read-only evidence. The plan must cite real files it inspected. `caw` records that repository's commit and hashes the cited files. Execution does not mount the reference repository; the implementer receives the captured file contents and can write only in the target worktree. A change to the reference during planning, execution, or review stops the run. A change to a cited file also stops approval and execution.

`--provider` accepts `codex` or `claude`. Omit it to use `defaultProvider` from the project configuration.

## Requirements

- Node.js 20+, Git, and either [OpenAI Codex CLI](https://learn.chatgpt.com/docs/non-interactive-mode) or [Claude Code CLI](https://code.claude.com/docs/en/cli-reference), installed and authenticated.
- A Git repository with an initial commit.
- Verification commands for the target project. `caw` does not infer a toolchain.

## Install

```bash
# In this repository:
npm install
npm test
npm link
```

`npm test` builds the CLI before running the tests. `npm link` installs the `caw` command for other local repositories. Without the link, run `node /absolute/path/to/code-agent-workflow/dist/src/cli.js <command>` from the target repository.

## Use it in a project

```bash
cd /path/to/your-project
caw init
caw doctor
```

`caw init` creates `.code-agent-workflow.json`, adds the private run directory to `.gitignore`, and creates `specs/example-feature.md`. Edit the verification commands and replace the example specification. The example is a template, so planning rejects it until you do. Commit that configuration first. Planning requires a clean worktree and a reproducible base commit.

```bash
git add .code-agent-workflow.json .gitignore specs/example-feature.md
git commit -m "Configure Code Agent Workflow"

caw plan specs/example-feature.md --provider codex
# Inspect .code-agent-workflow/runs/<run-id>/plan.md

caw approve <run-id>
caw run <run-id>

# If the worktree needs dependencies, install them yourself, for example with npm ci.
caw verify <run-id>
caw review <run-id> --provider claude

caw report <run-id>
caw status
caw metrics
```

`caw plan` prints the run ID. Use that ID in the later commands. Each run gets a `caw/<run-id>` branch and a linked worktree in a sibling directory such as `../.my-repo-caw-worktrees/<run-id>`. Execution leaves the original checkout unchanged except for ignored run logs.

## Configuration

`.code-agent-workflow.json` is intentionally small:

```json
{
  "schemaVersion": 1,
  "defaultProvider": "codex",
  "verify": [
    ["npm", "run", "typecheck"],
    ["npm", "run", "lint"],
    ["npm", "test"],
    ["npm", "run", "build"]
  ],
  "executionTimeoutMinutes": 20,
  "maxSpecBytes": 50000
}
```

Each `verify` entry is an argument array and is executed with `shell: false`. Replace the examples with the target project's commands, such as `["python", "-m", "pytest"]`, `["go", "test", "./..."]`, or `["dotnet", "test"]`. An empty list disables the gate, and `caw verify` refuses to run it.

## Specification format

A specification file needs three sections:

- `## Objective` or `## Goal`
- `## Scope`
- `## Acceptance criteria`, with at least one concrete criterion

`caw plan` rejects missing sections, empty sections, and obvious placeholders. See `examples/dialog-component.spec.md`. A `--prompt` request is saved as a specification snapshot for that run; you do not have to create the file yourself.

The planner is expected to inspect the repository and turn the request into `plan.md`. When a reference repository is present, that plan must include a `# Reference files` section listing the relative paths it actually inspected.

## Workflow

```text
Specification file or prompt
    |
    v
[Planner: read-only, optional reference repository] -> plan.md
    |
    v
[HUMAN: approve the plan snapshot]
    |
    v
[Implementer: write access only in a new worktree]
    |
    v
[Configured verification commands]
    |
    v
[Reviewer: fresh read-only session, advisory only]
    |
    v
[HUMAN: review the diff and merge through the normal process]
```

Separate runs can use separate worktrees and terminals. Version 0.1 does not schedule subagents inside one task, retry failed work, resolve branch conflicts, or merge results.

## Local evidence

```text
<target-repo>/
  .code-agent-workflow.json        # shared configuration; commit this
  specs/example-feature.md         # shared task; commit this
  .code-agent-workflow/            # private and gitignored
    runs/<run-id>/
      run.json                     # state, hashes, timeline, and outcomes
      spec.md                      # snapshotted request
      plan.md                      # planner output and approved content
      plan-agent.log
      execution-agent.log
      verify-1.log
      review-agent.log
      review.md
      REPORT.md
```

`caw metrics` summarizes the stages recorded by this repository. It is not a measure of model quality or productivity. `docs/EVALUATION.md` describes a more defensible evaluation.

## Security and limitations

Child processes receive explicit allowlisted environments. Provider authentication is sent only to the selected provider, while verification and internal Git commands receive no provider credentials. Stored Codex/Claude logins remain available through the allowed home and provider configuration directories. `CAW_CODEX_BIN` and `CAW_CLAUDE_BIN` select executables but are not forwarded. See [ADR-008](docs/ARCHITECTURE.md#adr-008-child-processes-receive-allowlisted-environments) for the exact variables and cloud-provider conditions.

Plan, execute, and review request no MCP tools. This is a provider command restriction, separate from the Codex sandbox, Claude's built-in tool list, and the child-environment allowlist. A Git worktree still only isolates the checkout. A passing local scan is not proof that every MCP source is disabled. See [ADR-009](docs/ARCHITECTURE.md#adr-009-mcp-tools-are-denied-by-default).

Claude receives `--strict-mcp-config` and `--disallowedTools mcp__*`, and receives no `--mcp-config`. Its existing read and edit tools stay available. `--strict-mcp-config` tells current Claude Code to ignore user, project, and plugin MCP configuration. `mcp__*` removes MCP tools from the model context. `caw` refuses to start Claude when a managed MCP file is deployed, because that flag cannot replace it. Remote managed MCP settings are not visible locally. A CLI that accepts the flags and still exposes a managed tool is outside this check.

Codex receives `--ignore-user-config`. Authentication still uses `CODEX_HOME`, and the stage sandbox is unchanged. The flag skips `$CODEX_HOME/config.toml`, including user MCP servers and saved project trust. It does not clear system, managed, or cloud MCP configuration, and `-c 'mcp_servers={}'` is not used because current Codex releases do not clear servers that way. `caw` parses project and host TOML and refuses the run when a relevant file defines MCP servers, plugins, hooks, or an `mcp_tool` hook, or when that file is malformed or unreadable. Comments and ordinary strings do not count. Cloud-managed Codex configuration, macOS managed preferences, Windows registry policy, app connectors, and the remote plugin catalog can still supply MCP tools. Codex provides no supported flag that skips them. A strict guarantee needs a container or VM that does not expose those sources or the host keyring. User model preferences in `config.toml` are not applied during a `caw` run.

1. Environment filtering prevents accidental inheritance of unrelated host variables. It does not stop a child process from reading accessible credential files, keychains, credential helpers, local services, or other host resources. A Git worktree separates changes but does not provide a secret or host-access sandbox. Use this on trusted code.
2. Codex plan and review calls use a read-only sandbox. Execution uses workspace write and does not receive `--add-dir` for a reference repository. Claude plan and review calls are limited to read tools. The read-only sandbox restricts writes. It does not guarantee that filesystem reads stay inside the repository. Planning and review prompts may allow native read-only commands such as `ls`, `rg`, `cat`, and `git show`; those sentences are not the write boundary. These provider controls depend on the installed CLI version and operating system. They are not a container boundary.
3. Instructions in prompts can be ignored by a model. `caw` enforces stage order, command arguments, file hashes, and whether a reference repository changed during a read-only stage.
4. Repository files and specifications are untrusted data. They can contain prompt injection. The role separation reduces that risk and does not eliminate it.
5. Run logs can contain source code or sensitive data. The run directory is gitignored. Remove sensitive content before sharing a report. `caw` uploads no telemetry. The provider CLI may send repository content to its service under your account settings.
6. Provider calls have a configurable wall-clock timeout. The tool does not record token cost or enforce a spending limit.
7. The worktree fingerprint detects ordinary tracked and untracked changes between verification and review. It is not a tamper-proof attestation.
8. Reviewer findings are advisory. An AI reviewer can miss defects. Read the diff and rely on independent CI before merging.
9. Automated tests use a mock agent. Run `caw doctor` and test the real provider on a disposable repository before using it for important work.
10. The plan is Markdown, not a schema-validated task graph. Cited reference paths are validated. Proposed new files in the target repository are not required to exist yet.

## Testing

```bash
npm test
```

The tests cover specification validation, provider permission arguments, local MCP preflight checks, subprocess environment isolation, binary overrides, the approval gate, worktree isolation, verification, review, reference-file checks, and rejection of a reference repository that changes during planning. `npm test` does not invoke Codex or Claude. MCP coverage is three separate kinds of evidence. Argument tests record the command this process builds. They do not prove that an installed binary honored the MCP flags. Local preflight tests reject project and host configuration this process can inspect, and they refuse the run when Git discovery or a configuration read fails. Real-provider checks live in `tests/mcp-provider-probe.test.ts` and stay skipped until you opt in. On a disposable machine with no Codex login, keyring entry, or managed policy, run:

```bash
CAW_MCP_PROVIDER_PROBE=1 npm test
```

That runs `codex mcp list` against a local server definition and a `codex exec` comparison with and without `--ignore-user-config`. `codex mcp list` does not start the server and cannot apply `--ignore-user-config`, so the exec comparison is the launch check.

## Further reading

- `docs/ARCHITECTURE.md` explains the component boundaries and engineering decisions.
- `docs/EVALUATION.md` describes how to measure the workflow honestly.
- `docs/ROADMAP.md` lists what remains before this becomes a shared developer platform.
