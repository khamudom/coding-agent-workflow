import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
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
  const readOnlyAccess = mode === "execute" ? [] : readDirectories;
  if (provider === "codex") {
    return {
      bin: process.env.CAW_CODEX_BIN || "codex",
      args: [
        "exec",
        "--ephemeral",
        "--sandbox",
        mode === "execute" ? "workspace-write" : "read-only",
        ...readOnlyAccess.flatMap(directory => ["--add-dir", directory]),
        "-",
      ],
    };
  }
  // Claude has separate tool permissions; restrict planning/review to read-like tools.
  // `dontAsk` denies anything requiring an interactive approval in non-interactive mode.
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
      "--max-turns",
      mode === "execute" ? "30" : "15",
      ...readOnlyAccess.flatMap(directory => ["--add-dir", directory]),
    ],
  };
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
  const { bin, args } = commandFor(provider, mode, prompt, readDirectories);
  mkdirSync(path.dirname(logFile), { recursive: true });
  console.log(`  ${provider} / ${mode} running in ${cwd}`);
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
