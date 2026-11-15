import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { childProcessEnvironment } from "./environment.js";
import type { Provider } from "./types.js";

export type Mode = "plan" | "execute" | "review";
export interface AgentResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export function commandFor(
  provider: Provider,
  mode: Mode,
  prompt: string,
  readDirectories: string[] = [],
): { bin: string; args: string[] } {
  // Codex treats --add-dir as a writable root. Only the read-only plan and review
  // sandboxes may receive a reference repository; execution must not mount it.
  // --ignore-user-config drops $CODEX_HOME/config.toml. Auth still uses CODEX_HOME.
  const readOnlyAccess = mode === "execute" ? [] : readDirectories;
  if (provider === "codex") {
    return {
      bin: process.env.CAW_CODEX_BIN || "codex",
      args: [
        "exec",
        "--ephemeral",
        "--ignore-user-config",
        "--sandbox",
        mode === "execute" ? "workspace-write" : "read-only",
        ...readOnlyAccess.flatMap(directory => ["--add-dir", directory]),
        "-",
      ],
    };
  }
  // Claude has separate tool permissions; restrict planning/review to read-like tools.
  // `dontAsk` denies anything requiring an interactive approval in non-interactive mode.
  // --tools does not apply to MCP tools. --strict-mcp-config loads only servers passed
  // with --mcp-config, and this command passes none. --disallowedTools removes MCP tools
  // that a managed source still injects.
  return {
    bin: process.env.CAW_CLAUDE_BIN || "claude",
    args: [
      "-p",
      prompt,
      "--output-format",
      "text",
      "--permission-mode",
      mode === "plan" ? "plan" : "dontAsk",
      "--tools",
      mode === "execute"
        ? "Read,Glob,Grep,Edit,Write,MultiEdit"
        : "Read,Glob,Grep",
      "--disallowedTools",
      "mcp__*",
      "--strict-mcp-config",
      "--max-turns",
      mode === "execute" ? "30" : "15",
      ...readOnlyAccess.flatMap(directory => ["--add-dir", directory]),
    ],
  };
}

export interface McpPolicyLocations {
  codexConfigFiles?: readonly string[];
  codexRequirementsFiles?: readonly string[];
  claudeManagedMcpFiles?: readonly string[];
  codexHome?: string;
}

export function mcpBoundaryReport(provider: Provider): string {
  if (provider === "claude") {
    return "Claude MCP: requested --strict-mcp-config with no --mcp-config, and denied mcp__*. Readable managed-mcp.json was checked. This does not prove remote managed MCP settings are absent. A strict guarantee requires a host without managed Claude MCP policy.";
  }
  return "Codex MCP: --ignore-user-config skips $CODEX_HOME/config.toml. Readable project, user-hook, system, and requirements files were checked. This scan does not prove every MCP source is disabled. Cloud-managed configuration, macOS managed preferences, the Windows Codex policy registry, app connectors, and the remote plugin catalog are not observable here. A strict guarantee requires an execution environment that does not include those sources.";
}

export function assertMcpPolicy(
  provider: Provider,
  cwd: string,
  locations?: McpPolicyLocations,
): void {
  if (provider === "claude") {
    for (const file of claudeManagedMcpFiles(locations)) {
      if (pathExists(file)) {
        throw new Error(
          `Claude Code cannot isolate MCP for this run. ${file} is a deployed managed MCP configuration. --strict-mcp-config cannot replace that file: Claude Code exits or keeps the managed servers. Refusing to start Claude Code.`,
        );
      }
    }
    return;
  }

  for (const directory of codexProjectDirectories(cwd)) {
    const configFile = path.join(directory, ".codex", "config.toml");
    const config = readOptional(configFile);
    const configRisk = config === undefined ? undefined : codexConfigRisk(parseCodexToml(config, configFile));
    if (configRisk) {
      throw new Error(
        `Codex cannot isolate MCP for this run. ${configFile} defines ${configRisk}. --ignore-user-config skips $CODEX_HOME/config.toml, and a trusted project .codex layer still loads. codex exec has no supported flag that skips project configuration, and -c 'mcp_servers={}' does not clear servers. Refusing to start Codex.`,
      );
    }
    const hooksFile = path.join(directory, ".codex", "hooks.json");
    if (pathExists(hooksFile)) {
      throw new Error(
        `Codex cannot isolate MCP for this run. ${hooksFile} is a project hook source. Project hooks load when the project is trusted, and system, managed, or cloud configuration can grant that trust while --ignore-user-config is set. Refusing to start Codex.`,
      );
    }
  }

  const home = codexHome(locations);
  if (home) {
    const hooksFile = path.join(home, "hooks.json");
    const hooks = readOptional(hooksFile);
    if (hooks !== undefined && userHooksCallMcp(hooks, hooksFile)) {
      throw new Error(
        `Codex cannot isolate MCP for this run. ${hooksFile} defines an mcp_tool hook. --ignore-user-config leaves $CODEX_HOME/hooks.json active. Refusing to start Codex.`,
      );
    }
  }

  for (const file of codexConfigFiles(locations)) {
    const contents = readOptional(file);
    const risk = contents === undefined ? undefined : codexConfigRisk(parseCodexToml(contents, file));
    if (risk) {
      throw new Error(
        `Codex cannot isolate MCP for this run. ${file} defines ${risk}. --ignore-user-config does not skip system or legacy managed configuration, and -c 'mcp_servers={}' does not clear servers. Refusing to start Codex.`,
      );
    }
  }
  for (const file of codexRequirementsFiles(locations)) {
    const contents = readOptional(file);
    if (contents !== undefined && containsMcpTool(parseCodexToml(contents, file))) {
      throw new Error(
        `Codex cannot isolate MCP for this run. ${file} defines an mcp_tool hook. --ignore-user-config does not skip requirements or managed hooks. Refusing to start Codex.`,
      );
    }
  }
}

export function hasBinary(bin: string): boolean {
  // --version should work for real clients; explicit mock binaries in tests also support it.
  try {
    const run = spawnSync(bin, ["--version"], {
      stdio: "ignore",
      timeout: 5000,
      shell: false,
      env: childProcessEnvironment("binary-detection"),
    });
    return !run.error && run.status === 0;
  } catch {
    return false;
  }
}

export async function invokeAgent(
  provider: Provider,
  mode: Mode,
  prompt: string,
  cwd: string,
  logFile: string,
  timeoutMinutes: number,
  readDirectories: string[] = [],
): Promise<AgentResult> {
  assertMcpPolicy(provider, cwd);
  const { bin, args } = commandFor(provider, mode, prompt, readDirectories);
  mkdirSync(path.dirname(logFile), { recursive: true });
  console.log(`  ${provider} / ${mode} running in ${cwd}`);
  console.log(`  ${mcpBoundaryReport(provider)}`);
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      env: childProcessEnvironment(provider),
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let completed = false;
    const timeout = setTimeout(
      () => {
        child.kill("SIGTERM");
      },
      timeoutMinutes * 60 * 1000,
    );
    child.stdout.on("data", (b: Buffer) => stdout.push(b));
    child.stderr.on("data", (b: Buffer) => {
      stderr.push(b);
      process.stderr.write(b);
    });
    // Codex accepts prompt on stdin; Claude receives the positional prompt argument.
    if (provider === "codex") child.stdin.end(prompt);
    else child.stdin.end();
    child.once("error", (err) => {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      reject(err);
    });
    child.once("close", (code, signal) => {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8");
      const exitCode = signal ? 124 : (code ?? 1);
      writeFileSync(
        logFile,
        `provider=${provider} mode=${mode} exit=${exitCode}\n--- STDOUT ---\n${out}\n--- STDERR ---\n${err}`,
        { mode: 0o600 },
      );
      resolve({
        exitCode,
        stdout: out,
        stderr: err,
        durationMs: Date.now() - started,
      });
    });
  });
}

function codexConfigFiles(locations: McpPolicyLocations | undefined): readonly string[] {
  if (locations?.codexConfigFiles) return locations.codexConfigFiles;
  if (process.platform === "win32") {
    return [path.join(windowsCodexSystemDir(), "config.toml")];
  }
  return ["/etc/codex/config.toml", "/etc/codex/managed_config.toml"];
}

function codexRequirementsFiles(locations: McpPolicyLocations | undefined): readonly string[] {
  if (locations?.codexRequirementsFiles) return locations.codexRequirementsFiles;
  if (process.platform === "win32") {
    return [path.join(windowsCodexSystemDir(), "requirements.toml")];
  }
  return ["/etc/codex/requirements.toml"];
}

function claudeManagedMcpFiles(locations: McpPolicyLocations | undefined): readonly string[] {
  if (locations?.claudeManagedMcpFiles) return locations.claudeManagedMcpFiles;
  if (process.platform === "win32") {
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    return [path.join(programFiles, "ClaudeCode", "managed-mcp.json")];
  }
  if (process.platform === "darwin") {
    return ["/Library/Application Support/ClaudeCode/managed-mcp.json"];
  }
  return ["/etc/claude-code/managed-mcp.json"];
}

function windowsCodexSystemDir(): string {
  return path.join(process.env.PROGRAMDATA || "C:\\ProgramData", "OpenAI", "Codex");
}

function codexHome(locations: McpPolicyLocations | undefined): string | undefined {
  if (locations?.codexHome !== undefined) return locations.codexHome || undefined;
  if (process.env.CODEX_HOME) return process.env.CODEX_HOME;
  const home = os.homedir();
  return home ? path.join(home, ".codex") : undefined;
}

function codexProjectDirectories(cwd: string): string[] {
  const start = path.resolve(cwd);
  const directories = new Set<string>([start]);
  const topLevel = gitMetadata(start, ["rev-parse", "--show-toplevel"]);
  if (!topLevel) return [...directories];
  addAncestorsUntil(directories, start, path.resolve(topLevel));
  const common = gitMetadata(start, ["rev-parse", "--git-common-dir"]);
  if (common) {
    const commonDir = path.resolve(start, common);
    if (path.basename(commonDir) === ".git") directories.add(path.dirname(commonDir));
  }
  return [...directories];
}

function addAncestorsUntil(directories: Set<string>, start: string, root: string): void {
  directories.add(root);
  const relative = path.relative(root, start);
  const inside = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  if (!inside) return;
  let current = start;
  while (current !== root) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
    directories.add(current);
  }
}

function gitMetadata(cwd: string, args: string[]): string | undefined {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    shell: false,
    timeout: 5000,
    env: childProcessEnvironment("git"),
  });
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  if (!result.error && result.status !== 0 && /not a git repository/i.test(stderr)) {
    if (!gitMetadataPresent(cwd)) return undefined;
    throw new Error(
      `Cannot inspect Git metadata for MCP configuration in ${cwd}. Git reported that this is not a repository, but .git is present and was not readable. Refusing to start Codex.`,
    );
  }
  if (result.error || result.status !== 0) {
    const detail = result.error
      ? result.error.message
      : stderr.trim() || `git exited ${result.status ?? "without a status"}`;
    throw new Error(`Cannot inspect Git metadata for MCP configuration in ${cwd} (${detail}). Refusing to start Codex.`);
  }
  const output = result.stdout.trim();
  if (!output) {
    throw new Error(`Cannot inspect Git metadata for MCP configuration in ${cwd} (git produced no path). Refusing to start Codex.`);
  }
  return output;
}

function gitMetadataPresent(start: string): boolean {
  let current = path.resolve(start);
  for (;;) {
    const gitPath = path.join(current, ".git");
    try {
      statSync(gitPath);
      return true;
    } catch (error) {
      if (!isNotFound(error)) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Cannot inspect ${gitPath} for project MCP configuration (${detail}). Refusing to start Codex.`);
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function pathExists(file: string): boolean {
  try {
    statSync(file);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot inspect ${file} to verify MCP isolation (${detail}). Refusing to start the agent.`);
  }
}

function readOptional(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read ${file} to verify MCP isolation (${detail}). Refusing to start the agent.`);
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function parseCodexToml(contents: string, file: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parseToml(contents);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Codex cannot validate MCP configuration in ${file} (${detail}). Malformed configuration is not evidence that no MCP servers exist. Refusing to start Codex.`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Codex cannot validate MCP configuration in ${file}. The document is not a TOML table. Refusing to start Codex.`);
  }
  return parsed as Record<string, unknown>;
}

function codexConfigRisk(doc: Record<string, unknown>): string | undefined {
  if (Object.hasOwn(doc, "mcp_servers")) return "mcp_servers";
  if (Object.hasOwn(doc, "plugins")) return "plugins";
  if (Object.hasOwn(doc, "hooks")) return "hooks";
  if (containsMcpTool(doc)) return "mcp_tool";
  return undefined;
}

function userHooksCallMcp(contents: string, file: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Codex cannot isolate MCP for this run. ${file} is not valid JSON (${detail}), so mcp_tool hooks cannot be ruled out. Refusing to start Codex.`,
    );
  }
  return containsMcpTool(parsed);
}

function containsMcpTool(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsMcpTool);
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.type === "mcp_tool") return true;
  return Object.values(record).some(containsMcpTool);
}
