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

The workflow does not push, merge, deploy, or install dependencies. Verification commands run with `shell: false`. Provider permissions and subprocess environment allowlists reduce exposure, but they are not a container or complete secret boundary.

## ADR-006: No parallel subagents inside a task yet

A planner, implementer, and reviewer are distinct roles executed sequentially. Independent task runs can operate concurrently in separate worktrees. Scheduling 10 concurrent editing agents would introduce merge contention and test attribution problems. Establish success rates and ownership rules before adding it.

## ADR-007: Reference repositories are read-only evidence

A plan may inspect another local Git repository. The reference commit and every cited file hash are recorded. Planning and review can read that repository; execution does not mount it. A change to the reference during planning, execution, or review stops the run. A change to a cited file also stops approval and execution. The implementer receives the captured file text and reimplements the behavior in the target worktree.

## ADR-008: Child processes receive allowlisted environments

Every child process receives a newly constructed environment rather than `process.env`. Binary detection and internal Git commands receive only the system variables below. Verification receives the same system variables plus `CI=true`; it never receives provider authentication. Agent invocations receive the system variables, `CI=true`, and only the variables for the selected provider. `CAW_CODEX_BIN` and `CAW_CLAUDE_BIN` are read by the coordinator to select an executable and are not forwarded.

The system allowlist supports executable lookup, user configuration, temporary files, locale handling, TLS certificate discovery, and macOS/Linux/Windows conventions:

- Executables and platform: `PATH`, `PATHEXT`, `SYSTEMROOT`, `WINDIR`, `COMSPEC`, `SYSTEMDRIVE`, `OS`, `PROCESSOR_ARCHITECTURE`, `PROCESSOR_ARCHITEW6432`
- Home and configuration: `HOME`, `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, `APPDATA`, `LOCALAPPDATA`, `PROGRAMDATA`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_RUNTIME_DIR`
- Temporary files and identity: `TMPDIR`, `TMP`, `TEMP`, `USER`, `LOGNAME`, `USERNAME`
- Locale and terminal behavior: `LANG`, `LANGUAGE`, `LC_ALL`, `LC_CTYPE`, `TZ`, `TERM`, `COLORTERM`, `NO_COLOR`, `FORCE_COLOR`, `__CF_USER_TEXT_ENCODING`
- TLS trust paths: `SSL_CERT_FILE`, `SSL_CERT_DIR`

Codex receives `CODEX_HOME` for its configuration/login directory. Authentication variables are `OPENAI_API_KEY`, `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`, `OPENAI_FEDERATION_RULE_ID`, `OPENAI_IDENTITY_TOKEN_FILE`, and `OPENAI_WORKLOAD_IDENTITY_CONTEXT`. `CODEX_CA_CERTIFICATE` supports a Codex-specific CA bundle. The current Codex environment reference does not document standard proxy variables, so they are not forwarded. Without an environment credential, the CLI can use the login stored under `CODEX_HOME` or the normal home directory.

Claude receives these direct authentication and routing variables:

- Login and configuration: `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_PROFILE`
- API and gateway authentication: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_CUSTOM_HEADERS`
- Model selection: `ANTHROPIC_MODEL`
- Network compatibility: `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, their lowercase forms, and `NODE_EXTRA_CA_CERTS`. Proxy values may contain embedded credentials and are therefore limited to Claude.
- Windows shell compatibility: `CLAUDE_CODE_GIT_BASH_PATH`
- Workload identity federation: `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID`, `ANTHROPIC_IDENTITY_TOKEN_FILE`, `ANTHROPIC_IDENTITY_TOKEN`, `ANTHROPIC_SERVICE_ACCOUNT_ID`, `ANTHROPIC_WORKSPACE_ID`

Third-party Claude backends are opt-in. A selector is enabled only when its trimmed value is `1`, `true`, `yes`, or `on`, in any letter case. An enabled selector is forwarded as `1`. Disabled, empty, missing, and other unsupported values are omitted and do not forward that backend's credentials:

- Bedrock (`CLAUDE_CODE_USE_BEDROCK`): `CLAUDE_CODE_SKIP_BEDROCK_AUTH`, `CLAUDE_CODE_USE_MANTLE`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_PROFILE`, `AWS_REGION`, `AWS_DEFAULT_REGION`, `AWS_SHARED_CREDENTIALS_FILE`, `AWS_CONFIG_FILE`, `AWS_SDK_LOAD_CONFIG`, `AWS_WEB_IDENTITY_TOKEN_FILE`, `AWS_ROLE_ARN`, `AWS_ROLE_SESSION_NAME`, `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`, `AWS_CONTAINER_CREDENTIALS_FULL_URI`, `AWS_CONTAINER_AUTHORIZATION_TOKEN`, `AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE`, `AWS_BEARER_TOKEN_BEDROCK`, `ANTHROPIC_BEDROCK_BASE_URL`, `ANTHROPIC_BEDROCK_MANTLE_BASE_URL`, `ANTHROPIC_BEDROCK_REGION_PREFIX`, `ANTHROPIC_BEDROCK_SERVICE_TIER`
- Google Cloud's Agent Platform (`CLAUDE_CODE_USE_VERTEX`): `CLAUDE_CODE_SKIP_VERTEX_AUTH`, `GOOGLE_APPLICATION_CREDENTIALS`, `CLOUD_ML_REGION`, `ANTHROPIC_VERTEX_PROJECT_ID`, `ANTHROPIC_VERTEX_BASE_URL`
- Microsoft Foundry (`CLAUDE_CODE_USE_FOUNDRY`): `CLAUDE_CODE_SKIP_FOUNDRY_AUTH`, `ANTHROPIC_FOUNDRY_API_KEY`, `ANTHROPIC_FOUNDRY_AUTH_TOKEN`, `ANTHROPIC_FOUNDRY_RESOURCE`, `ANTHROPIC_FOUNDRY_BASE_URL`, `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_CLIENT_CERTIFICATE_PATH`, `AZURE_CLIENT_CERTIFICATE_PASSWORD`, `AZURE_FEDERATED_TOKEN_FILE`, `AZURE_AUTHORITY_HOST`
- Claude Platform on AWS (`CLAUDE_CODE_USE_ANTHROPIC_AWS`): `CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH`, `ANTHROPIC_AWS_API_KEY`, `ANTHROPIC_AWS_WORKSPACE_ID`, `ANTHROPIC_AWS_BASE_URL`, and the AWS credential variables listed for Bedrock

This boundary prevents accidental inheritance of unrelated variables such as repository tokens, package registry credentials, SSH agent sockets, and arbitrary host secrets. It does not prevent a provider, agent tool, Git hook, or verification command from reading accessible files, keychains, credential helpers, local services, or other host resources. Provider credentials necessarily exist in the selected provider process and may be visible to subprocesses that provider starts, subject to that CLI's own scrubbing behavior. Environment isolation is therefore defense in depth, not a sandbox.

## ADR-009: MCP tools are denied by default

Plan, execute, and review request no MCP tools. The provider command and local checks enforce that request. Prompt text is not the control. There is no project setting that allowlists MCP servers. A local check that passes does not prove every MCP source is disabled. Approved MCP integrations can be added later as a separate feature.

MCP restriction, process sandboxing, and environment filtering are three different controls. Claude's `--tools` list and Codex's `--sandbox` value bound built-in file and command tools. The child-environment allowlist chooses inherited variables. MCP policy chooses whether MCP servers and MCP tools are available. A Git worktree isolates the checkout being edited. None of these controls is a container.

The sources below are classified by what this process can actually do.

Explicitly disabled:

- Claude user, project, and plugin MCP configuration, through `--strict-mcp-config` with no `--mcp-config`. MCP tool names, through `--disallowedTools mcp__*`.
- The Codex user layer in `$CODEX_HOME/config.toml`, through `--ignore-user-config`. Authentication still uses `CODEX_HOME`.

Validated and rejected before the process starts:

- A readable Claude `managed-mcp.json` on the platform path, including an empty file.
- A Codex project `.codex/config.toml` whose parsed document defines `mcp_servers`, `plugins`, `hooks`, or an `mcp_tool` hook. Quoted, dotted, nested, and inline tables count. A comment or an ordinary string does not.
- A Codex project `.codex/hooks.json`, because project hooks load when any remaining layer trusts the project.
- `$CODEX_HOME/hooks.json` when it contains an `mcp_tool` hook or is not valid JSON.
- System and legacy managed Codex config files when the parsed document defines those entries.
- Requirements files when the parsed document defines an `mcp_tool` hook. An `mcp_servers` allowlist there disables non-matching servers, so its presence does not refuse the run.
- Malformed TOML in any of those Codex files. That is a failure to validate, not evidence that no MCP server exists.
- A Git inspection failure, including `.git` metadata that Git cannot read. A directory that is not a Git repository is scanned only at that directory. A missing optional file is absence. Permission errors and other filesystem errors refuse the run.

Potentially active, and not observable from this process:

- Codex cloud-managed configuration.
- macOS managed preferences.
- The Windows Codex policy registry under `SOFTWARE\Policies\OpenAI\Codex`.
- Codex app connectors and the remote plugin catalog.
- Claude `managedMcpServers` delivered without a local `managed-mcp.json`.
- Command hooks that are not `mcp_tool` hooks. Those hooks still run.

A strict guarantee needs an execution environment that does not include those unobservable sources. That means a container or VM whose provider process cannot read the host keyring, host managed preferences, or a cloud policy for the provider account. This harness does not create that environment. `caw doctor` and the startup line name the gap. They do not close it.

### Claude Code

Every Claude stage passes `--strict-mcp-config` and `--disallowedTools mcp__*`, and passes no `--mcp-config`. Current Claude Code help describes `--strict-mcp-config` as using only the servers supplied by `--mcp-config` and ignoring other MCP configurations, including user, project, and plugin servers. Current permission docs say `--tools` does not affect MCP tools, and a bare `mcp__*` deny removes every MCP tool from the model context, including plugin tools whose names start with `mcp__`.

The existing tool boundary stays in place. Plan uses `--permission-mode plan` and `Read,Glob,Grep`. Execute and review use `dontAsk`. Execute adds `Edit,Write,MultiEdit`. Reference directories are still mounted only for plan and review. `--bare` is not used: that mode does not read OAuth or keychain credentials. `--safe-mode` is not used: it disables project instructions, skills, and hooks beyond the MCP boundary.

`caw` refuses to start Claude when a managed MCP file is present:

- macOS: `/Library/Application Support/ClaudeCode/managed-mcp.json`
- Linux: `/etc/claude-code/managed-mcp.json`
- Windows: `C:\Program Files\ClaudeCode\managed-mcp.json`

Current Claude Code docs say `--strict-mcp-config` exits when that file is deployed, and the file can force its own server set. The refusal happens before the process starts. Absence of the file is not proof that remote managed settings are absent.

`managedMcpServers` without that file is omitted by `--strict-mcp-config` in the current docs, and `mcp__*` removes a tool that still appears. Those settings can be fetched from the network, so `caw` cannot inspect them. An older CLI that rejects either flag fails the stage. A CLI that accepts the flags and still exposes a managed MCP tool is outside what `caw` can detect. Claude settings, skills, and command hooks still load; a hook can run a program even when MCP tools are removed.

### Codex

Every Codex stage passes `exec --ephemeral --ignore-user-config` and the existing sandbox: `read-only` for plan and review, `workspace-write` for execution. The read-only sandbox restricts writes. It does not guarantee filesystem read isolation. Planning and review prompts allow `ls`, `rg`, `cat`, and `git show` so Codex can inspect the repository without MCP. Those prompt lines are not the security boundary. The flag's documented contract is that `$CODEX_HOME/config.toml` is not loaded and authentication still uses `CODEX_HOME`. That removes user MCP servers, user preferences, inline hooks in that file, and project trust saved in that file. `CODEX_HOME`, `OPENAI_API_KEY`, `CODEX_API_KEY`, and the other Codex authentication variables from ADR-008 are still forwarded.

The command does not pass `-c 'mcp_servers={}'`. Current Codex releases merge that empty table and leave configured servers enabled. It does not pass `--trust`, which would enable project configuration and cannot be combined with `--ignore-user-config`. It does not pass `--ignore-rules`, because that skips user and project execpolicy `.rules` files and those rules can only add command restrictions. It does not pass `--dangerously-bypass-approvals-and-sandbox`.

Project `.codex` configuration still loads when a remaining layer trusts the project. System config, legacy managed config, cloud-managed config, and macOS managed preferences can grant that trust. `caw` therefore refuses to start Codex when either of these is found from the working directory through the Git root, and in the main checkout of a linked worktree:

- `.codex/config.toml` parses as a document that defines `mcp_servers`, `plugins`, `hooks`, or an `mcp_tool` hook
- `.codex/hooks.json` exists

Detection parses TOML. `["mcp_servers".probe]`, `['mcp_servers'.probe]`, dotted keys, and inline tables are the same configuration as `[mcp_servers.probe]`. A comment, a string value, or a single quoted key whose name merely contains `mcp_servers` is not. Malformed TOML refuses the run. An unreadable configuration file refuses the run. A file that is not present does not.

`$CODEX_HOME/hooks.json` still loads. The user config layer is empty, and hook discovery still reads that directory. `caw` refuses the run when that file contains an `mcp_tool` hook or is not valid JSON. Command hooks in that file still run.

These host files still load, and `caw` refuses the run when a parsed config file defines `mcp_servers`, `plugins`, `hooks`, or `mcp_tool`, or when the file cannot be parsed:

- Unix: `/etc/codex/config.toml`, `/etc/codex/managed_config.toml`
- Windows: `%ProgramData%\OpenAI\Codex\config.toml`

`/etc/codex/requirements.toml` and `%ProgramData%\OpenAI\Codex\requirements.toml` constrain the client. An `mcp_servers` entry there is an allowlist that disables non-matching servers, so its presence does not refuse the run. An `mcp_tool` hook in that file refuses the run. Malformed requirements TOML also refuses the run. Command hooks in that file still run.

Cloud-managed configuration, macOS managed preferences, and the Windows Codex policy registry can still supply MCP servers, plugins, and project trust. Codex has no supported CLI flag that skips those layers, and `caw` cannot read them. A scan that finds no readable violation does not prove those sources are disabled. Codex app connectors and the remote plugin catalog are separate from `mcp_servers`; `--ignore-user-config` does not disable them. A strict guarantee requires the isolated execution environment described above.

User model and approval preferences stored in `config.toml` are not applied during a `caw` run. The explicit `--sandbox` value still selects the stage sandbox, and reference directories are still withheld from execution. An installed Codex that rejects `--ignore-user-config` fails the stage instead of running with user MCP servers loaded.

## Non-goals for v0.1

Production CI/CD automation; database persistence; distributed queues; cloud execution; autonomous PR/merge; managing authentication; robust secret redaction; arbitrary repo dependency bootstrap; cross-worktree dependency graphs; UI dashboard.
