import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { childProcessEnvironment } from "../src/environment.js";
import { assertMcpPolicy, commandFor, invokeAgent, mcpBoundaryReport, type Mode } from "../src/providers.js";

// These tests lock the arguments and local fail-closed decisions this process controls.
// A mock binary recording those arguments does not prove Codex or Claude enforced them.

const modes: Mode[] = ["plan", "execute", "review"];

function hermetic(root: string, extra: Parameters<typeof assertMcpPolicy>[2] = {}) {
  return {
    codexConfigFiles: [] as string[],
    codexRequirementsFiles: [] as string[],
    claudeManagedMcpFiles: [] as string[],
    codexHome: path.join(root, "codex-home"),
    ...extra,
  };
}

function git(cwd: string, args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

test("Claude plan, execute, and review request MCP denial without a custom MCP config", () => {
  for (const mode of modes) {
    const command = commandFor("claude", mode, "prompt text", ["/tmp/reference"]);
    assert.equal(command.args.includes("--strict-mcp-config"), true);
    assert.equal(command.args[command.args.indexOf("--disallowedTools") + 1], "mcp__*");
    assert.equal(command.args.includes("--mcp-config"), false);
    assert.equal(command.args.includes("--bare"), false);
    assert.equal(command.args.includes("--safe-mode"), false);
    assert.equal(command.args[command.args.indexOf("--permission-mode") + 1], mode === "plan" ? "plan" : "dontAsk");
    const tools = command.args[command.args.indexOf("--tools") + 1];
    assert.match(tools ?? "", /Read,Glob,Grep/);
    if (mode === "execute") {
      assert.match(tools ?? "", /Edit,Write,MultiEdit/);
      assert.equal(command.args.includes("--add-dir"), false);
    } else {
      assert.equal(tools?.includes("Edit"), false);
      assert.equal(command.args.includes("--add-dir"), true);
      assert.equal(command.args[command.args.indexOf("--add-dir") + 1], "/tmp/reference");
    }
  }
});

test("Codex plan, execute, and review skip user config and keep the existing sandbox", () => {
  for (const mode of modes) {
    const command = commandFor("codex", mode, "prompt text", ["/tmp/reference"]);
    assert.equal(command.args[0], "exec");
    assert.equal(command.args.includes("--ephemeral"), true);
    assert.equal(command.args.includes("--ignore-user-config"), true);
    assert.equal(command.args.includes("--trust"), false);
    assert.equal(command.args.includes("--ignore-rules"), false);
    assert.equal(command.args.includes("--dangerously-bypass-approvals-and-sandbox"), false);
    assert.equal(command.args.includes("-c"), false);
    assert.equal(command.args.some(arg => arg.includes("mcp_servers")), false);
    assert.equal(command.args.at(-1), "-");
    assert.equal(
      command.args[command.args.indexOf("--sandbox") + 1],
      mode === "execute" ? "workspace-write" : "read-only",
    );
    if (mode === "execute") assert.equal(command.args.includes("--add-dir"), false);
    else assert.equal(command.args[command.args.indexOf("--add-dir") + 1], "/tmp/reference");
  }
});

test("provider authentication variables are still forwarded with MCP restrictions", () => {
  const source = {
    PATH: "/usr/bin",
    HOME: "/home/tester",
    OPENAI_API_KEY: "openai-key",
    CODEX_API_KEY: "codex-key",
    CODEX_ACCESS_TOKEN: "codex-token",
    CODEX_HOME: "/home/tester/.codex",
    ANTHROPIC_API_KEY: "anthropic-key",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
    CLAUDE_CONFIG_DIR: "/home/tester/.claude",
    CAW_CODEX_BIN: "/opt/codex",
    CAW_CLAUDE_BIN: "/opt/claude",
  };
  const codex = childProcessEnvironment("codex", source);
  assert.equal(codex.OPENAI_API_KEY, source.OPENAI_API_KEY);
  assert.equal(codex.CODEX_API_KEY, source.CODEX_API_KEY);
  assert.equal(codex.CODEX_ACCESS_TOKEN, source.CODEX_ACCESS_TOKEN);
  assert.equal(codex.CODEX_HOME, source.CODEX_HOME);
  assert.equal(codex.CAW_CODEX_BIN, undefined);
  const claude = childProcessEnvironment("claude", source);
  assert.equal(claude.ANTHROPIC_API_KEY, source.ANTHROPIC_API_KEY);
  assert.equal(claude.CLAUDE_CODE_OAUTH_TOKEN, source.CLAUDE_CODE_OAUTH_TOKEN);
  assert.equal(claude.CLAUDE_CONFIG_DIR, source.CLAUDE_CONFIG_DIR);
  assert.equal(claude.CAW_CLAUDE_BIN, undefined);
  assert.equal(commandFor("codex", "execute", "x").bin, "codex");
  assert.equal(commandFor("claude", "plan", "x").bin, "claude");
});

test("project Codex MCP, plugin, and hook configuration fails closed", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "caw-mcp-"));
  const repo = path.join(root, "repo");
  mkdirSync(path.join(repo, ".codex"), { recursive: true });
  const config = path.join(repo, ".codex", "config.toml");
  const locations = hermetic(root);
  writeFileSync(config, "model = \"gpt\"\nnote = \"keep # mcp_servers mentioned\"\n");
  assert.doesNotThrow(() => assertMcpPolicy("codex", repo, locations));

  writeFileSync(config, "[mcp_servers.probe]\ncommand = \"true\"\n");
  assert.throws(() => assertMcpPolicy("codex", repo, locations), /defines mcp_servers/);

  writeFileSync(config, "plugins = { browser = {} }\n");
  assert.throws(() => assertMcpPolicy("codex", repo, locations), /defines plugins/);

  writeFileSync(config, "[hooks]\n");
  assert.throws(() => assertMcpPolicy("codex", repo, locations), /defines hooks/);

  writeFileSync(config, "model = \"gpt\"\n");
  writeFileSync(path.join(repo, ".codex", "hooks.json"), "{}\n");
  assert.throws(() => assertMcpPolicy("codex", repo, locations), /project hook source/);
});

test("Codex sees project MCP configuration from a subdirectory and a linked worktree", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "caw-mcp-git-"));
  const repo = path.join(root, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  writeFileSync(path.join(repo, "README.md"), "fixture\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "initial"]);
  mkdirSync(path.join(repo, ".codex"));
  writeFileSync(path.join(repo, ".codex", "config.toml"), "[mcp_servers.probe]\ncommand = \"true\"\n");
  const nested = path.join(repo, "src");
  mkdirSync(nested);
  const locations = hermetic(root);
  assert.throws(() => assertMcpPolicy("codex", nested, locations), /defines mcp_servers/);

  const worktree = path.join(root, "worktree");
  git(repo, ["worktree", "add", "-q", worktree, "HEAD"]);
  assert.equal(existsSync(path.join(worktree, ".codex")), false);
  assert.throws(() => assertMcpPolicy("codex", worktree, locations), /defines mcp_servers/);
});

test("host Codex configuration and user MCP hooks fail closed", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "caw-mcp-host-"));
  const repo = path.join(root, "repo");
  const home = path.join(root, "home");
  mkdirSync(repo);
  mkdirSync(home);
  const system = path.join(root, "config.toml");
  const requirements = path.join(root, "requirements.toml");
  const locations = hermetic(root, {
    codexConfigFiles: [system],
    codexRequirementsFiles: [requirements],
    codexHome: home,
  });

  writeFileSync(requirements, "[mcp_servers.allowed]\ncommand = \"example\"\n");
  assert.doesNotThrow(() => assertMcpPolicy("codex", repo, locations));
  writeFileSync(requirements, "[[hooks.PreToolUse.hooks]]\ntype = \"mcp_tool\"\n");
  assert.throws(() => assertMcpPolicy("codex", repo, locations), /mcp_tool hook/);

  writeFileSync(requirements, "");
  writeFileSync(system, "[mcp_servers.probe]\ncommand = \"true\"\n");
  assert.throws(() => assertMcpPolicy("codex", repo, locations), /does not skip system or legacy managed/);

  writeFileSync(system, "model = \"gpt\"\n");
  const hooks = path.join(home, "hooks.json");
  writeFileSync(hooks, JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "true" }] }] } }));
  assert.doesNotThrow(() => assertMcpPolicy("codex", repo, locations));
  writeFileSync(hooks, JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "mcp_tool", server: "probe" }] }] } }));
  assert.throws(() => assertMcpPolicy("codex", repo, locations), /mcp_tool hook/);
  writeFileSync(hooks, "{");
  assert.throws(() => assertMcpPolicy("codex", repo, locations), /not valid JSON/);
});

test("a deployed Claude managed MCP file fails closed and a project .mcp.json does not", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "caw-mcp-claude-"));
  const repo = path.join(root, "repo");
  mkdirSync(repo);
  writeFileSync(path.join(repo, ".mcp.json"), "{\"mcpServers\":{\"probe\":{\"command\":\"true\"}}}\n");
  const managed = path.join(root, "managed-mcp.json");
  const locations = hermetic(root, { claudeManagedMcpFiles: [] });
  assert.doesNotThrow(() => assertMcpPolicy("claude", repo, locations));
  writeFileSync(managed, "{}\n");
  assert.throws(
    () => assertMcpPolicy("claude", repo, hermetic(root, { claudeManagedMcpFiles: [managed] })),
    /deployed managed MCP configuration/,
  );
});

test("quoted, nested, and inline Codex TOML cannot hide an MCP definition", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "caw-mcp-toml-"));
  const repo = path.join(root, "repo");
  mkdirSync(path.join(repo, ".codex"), { recursive: true });
  const config = path.join(repo, ".codex", "config.toml");
  const locations = hermetic(root);
  const prohibited = [
    '["mcp_servers".probe]\ncommand = "true"\n',
    "['mcp_servers'.probe]\ncommand = \"true\"\n",
    '["mcp_servers"."probe"]\ncommand = "true"\n',
    'mcp_servers.probe.command = "true"\n',
    '"mcp_servers".probe.command = "true"\n',
    "mcp_servers = { probe = { command = \"true\" } }\n",
    "[mcp_servers]\n",
    "[mcp_servers.probe.tools]\nname = \"x\"\n",
    '["plugins".browser]\ncommand = "true"\n',
    'hooks = { PreToolUse = { hooks = [{ type = "mcp_tool" }] } }\n',
  ];
  for (const contents of prohibited) {
    writeFileSync(config, contents);
    assert.throws(() => assertMcpPolicy("codex", repo, locations), /defines (mcp_servers|plugins|hooks|mcp_tool)/, contents);
  }

  const allowed = [
    'model = "gpt"\nnote = "keep # mcp_servers mentioned"\n# [mcp_servers.probe]\n',
    'note = "mcp_servers"\n',
    // One quoted key that contains a dot is not the mcp_servers table.
    '["mcp_servers.probe"]\ncommand = "true"\n',
    "model = \"gpt\"\n",
  ];
  for (const contents of allowed) {
    writeFileSync(config, contents);
    try {
      assertMcpPolicy("codex", repo, locations);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      assert.fail(`${contents}\n${detail}`);
    }
  }

  writeFileSync(config, '["mcp_servers".probe\ncommand = "true"\n');
  assert.throws(() => assertMcpPolicy("codex", repo, locations), /cannot validate MCP configuration/);
});

test("malformed Codex requirements fail closed and an allowlist does not", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "caw-mcp-requirements-"));
  const repo = path.join(root, "repo");
  mkdirSync(repo);
  const requirements = path.join(root, "requirements.toml");
  const locations = hermetic(root, { codexRequirementsFiles: [requirements] });
  writeFileSync(requirements, "[mcp_servers.allowed]\ncommand = \"example\"\n");
  assert.doesNotThrow(() => assertMcpPolicy("codex", repo, locations));
  writeFileSync(requirements, "note = \"mcp_tool\"\n# mcp_tool\n");
  assert.doesNotThrow(() => assertMcpPolicy("codex", repo, locations));
  writeFileSync(requirements, "[[hooks.PreToolUse.hooks\n");
  assert.throws(() => assertMcpPolicy("codex", repo, locations), /cannot validate MCP configuration/);
});

test("the MCP boundary report names sources the local scan cannot prove disabled", () => {
  const codex = mcpBoundaryReport("codex");
  assert.match(codex, /does not prove every MCP source is disabled/);
  assert.match(codex, /Cloud-managed configuration/);
  assert.match(codex, /macOS managed preferences/);
  assert.match(codex, /strict guarantee requires an execution environment/);
  const claude = mcpBoundaryReport("claude");
  assert.match(claude, /does not prove remote managed MCP settings are absent/);
  assert.match(claude, /--strict-mcp-config/);
  assert.match(claude, /mcp__\*/);
});

test("failed Git discovery cannot skip project MCP configuration", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "caw-mcp-git-fail-"));
  const repo = path.join(root, "repo");
  mkdirSync(repo);
  git(repo, ["init", "-q"]);
  mkdirSync(path.join(repo, ".codex"));
  writeFileSync(path.join(repo, ".codex", "config.toml"), "[mcp_servers.probe]\ncommand = \"true\"\n");
  const nested = path.join(repo, "src");
  mkdirSync(nested);
  const locations = hermetic(root);
  assert.throws(() => assertMcpPolicy("codex", nested, locations), /defines mcp_servers/);

  const marker = path.join(root, "started.txt");
  const fake = path.join(root, "mock-agent.cjs");
  writeFileSync(fake, `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "started\\n");\nconsole.log("ok");\n`);
  chmodSync(fake, 0o755);
  const gitDir = path.join(repo, ".git");
  rmSync(gitDir, { recursive: true, force: true });
  const missingGitDir = path.join(root, "missing-gitdir").split(path.sep).join("/");
  writeFileSync(gitDir, `gitdir: ${missingGitDir}\n`);
  const previous = process.env.CAW_CODEX_BIN;
  process.env.CAW_CODEX_BIN = fake;
  try {
    assert.throws(() => assertMcpPolicy("codex", nested, locations), /Cannot inspect Git metadata/);
    await assert.rejects(
      () => invokeAgent("codex", "execute", "prompt", nested, path.join(root, "agent.log"), 1),
      /Cannot inspect Git metadata/,
    );
    assert.equal(existsSync(marker), false);
  } finally {
    if (previous === undefined) delete process.env.CAW_CODEX_BIN;
    else process.env.CAW_CODEX_BIN = previous;
  }
});

test("missing optional MCP files are absent and invalid paths fail closed", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "caw-mcp-access-"));
  const repo = path.join(root, "repo");
  mkdirSync(repo);
  const locations = hermetic(root, {
    codexConfigFiles: [path.join(root, "missing-config.toml")],
    codexRequirementsFiles: [path.join(root, "missing-requirements.toml")],
    claudeManagedMcpFiles: [path.join(root, "missing-managed-mcp.json")],
  });
  assert.doesNotThrow(() => assertMcpPolicy("codex", repo, locations));
  assert.doesNotThrow(() => assertMcpPolicy("claude", repo, locations));

  writeFileSync(path.join(repo, ".codex"), "not a directory\n");
  assert.throws(() => assertMcpPolicy("codex", repo, locations), /Cannot read/);

  const notDirectory = path.join(root, "not-a-directory");
  writeFileSync(notDirectory, "not a directory\n");
  assert.throws(
    () => assertMcpPolicy("claude", repo, hermetic(root, { claudeManagedMcpFiles: [path.join(notDirectory, "managed-mcp.json")] })),
    /Cannot inspect/,
  );
});

test("Codex does not start when the repository defines an MCP server", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "caw-mcp-spawn-"));
  const repo = path.join(root, "repo");
  mkdirSync(path.join(repo, ".codex"), { recursive: true });
  writeFileSync(path.join(repo, ".codex", "config.toml"), "[mcp_servers.probe]\ncommand = \"true\"\n");
  const marker = path.join(root, "started.txt");
  const fake = path.join(root, "mock-agent.cjs");
  writeFileSync(fake, `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "started\\n");\nconsole.log("ok");\n`);
  chmodSync(fake, 0o755);
  const previous = process.env.CAW_CODEX_BIN;
  process.env.CAW_CODEX_BIN = fake;
  try {
    await assert.rejects(
      () => invokeAgent("codex", "execute", "prompt", repo, path.join(root, "agent.log"), 1),
      /defines mcp_servers/,
    );
    assert.equal(existsSync(marker), false);
  } finally {
    if (previous === undefined) delete process.env.CAW_CODEX_BIN;
    else process.env.CAW_CODEX_BIN = previous;
  }
});
