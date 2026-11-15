import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync, lstatSync, readlinkSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { childProcessEnvironment } from "./environment.js";
import type { Config, Run } from "./types.js";

export const CONFIG_NAME = ".code-agent-workflow.json";
export const STATE_DIR = ".code-agent-workflow";
export function git(repo: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: childProcessEnvironment("git"),
  }).trim();
}
export function repoRoot(start = process.cwd()): string {
  try { return git(start, ["rev-parse", "--show-toplevel"]); }
  catch { throw new Error(`Not a Git repository: ${start}. Run git init first.`); }
}
export function safeJson<T>(file: string): T {
  if (!existsSync(file)) throw new Error(`File not found: ${file}`);
  return JSON.parse(readFileSync(file, "utf8")) as T;
}
export function loadConfig(repo: string): Config {
  const config = safeJson<Config>(path.join(repo, CONFIG_NAME));
  if (config.schemaVersion !== 1 || !["claude", "codex"].includes(config.defaultProvider) ||
      !Array.isArray(config.verify) || !config.verify.every(cmd => Array.isArray(cmd) && cmd.length > 0 && cmd.every(x => typeof x === "string" && x.length > 0)) ||
      typeof config.executionTimeoutMinutes !== "number" || config.executionTimeoutMinutes < 1 || config.executionTimeoutMinutes > 120 ||
      typeof config.maxSpecBytes !== "number" || config.maxSpecBytes < 100 || config.maxSpecBytes > 1_000_000) {
    throw new Error(`Invalid ${CONFIG_NAME}. Check schema, verify commands, timeout, and spec size.`);
  }
  return config;
}
export function runDir(repo: string, id: string): string {
  if (!/^run-[0-9TZ-]+-[a-f0-9]{8}$/.test(id)) throw new Error("Invalid run ID");
  return path.join(repo, STATE_DIR, "runs", id);
}
export function saveRun(run: Run): void {
  const dir = runDir(run.repoRoot, run.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "run.json"), JSON.stringify(run, null, 2) + "\n", { mode: 0o600 });
}
export function loadRun(repo: string, id: string): Run {
  const run = safeJson<Run>(path.join(runDir(repo, id), "run.json"));
  if (run.schemaVersion !== 1 || run.id !== id || run.repoRoot !== repo) throw new Error("Invalid or foreign run state");
  return run;
}
export function hashText(s: string): string { return createHash("sha256").update(s).digest("hex"); }
export function newId(): string {
  return `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}`;
}
export function record(run: Run, event: string, note?: string): void {
  run.eventLog.push({ at: new Date().toISOString(), event, ...(note ? { note } : {}) });
  saveRun(run);
}
export function assertClean(repo: string): void {
  const changes = git(repo, ["status", "--porcelain", "--untracked-files=all"]);
  if (changes) throw new Error("Working tree has uncommitted/untracked changes. Commit or stash before planning or execution.\n" + changes.slice(0, 1400));
}
export function appendIgnore(repo: string): void {
  const ignore = path.join(repo, ".gitignore");
  const contents = existsSync(ignore) ? readFileSync(ignore, "utf8") : "";
  if (!contents.split(/\r?\n/).includes(".code-agent-workflow/")) {
    appendFileSync(ignore, `${contents && !contents.endsWith("\n") ? "\n" : ""}\n# Local AI workflow artifacts and transcripts\n.code-agent-workflow/\n`);
  }
}
export function listRunIds(repo: string): string[] {
  const root = path.join(repo, STATE_DIR, "runs");
  if (!existsSync(root)) return [];
  return readdirSync(root).filter(id => /^run-[0-9TZ-]+-[a-f0-9]{8}$/.test(id)).sort().reverse();
}

/** Fingerprint both tracked modifications and untracked files. Not a cryptographic attestation of a host. */
export function worktreeHash(worktree: string, baseCommit: string): string {
  const h = createHash("sha256");
  h.update(git(worktree, ["diff", "--binary", "--no-ext-diff", baseCommit]));
  const untracked = git(worktree, ["ls-files", "--others", "--exclude-standard"]);
  for (const name of untracked ? untracked.split("\n").sort() : []) {
    const file = path.resolve(worktree, name);
    if (!file.startsWith(worktree + path.sep)) throw new Error("Unsafe untracked path");
    const stat = lstatSync(file);
    h.update(name);
    if (stat.isSymbolicLink()) h.update(readlinkSync(file));
    else if (stat.isFile()) h.update(readFileSync(file));
  }
  return h.digest("hex");
}
