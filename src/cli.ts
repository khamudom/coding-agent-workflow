#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { appendIgnore, assertClean, CONFIG_NAME, git, hashText, listRunIds, loadConfig, loadRun, newId, record, repoRoot, runDir, saveRun, worktreeHash } from "./paths.js";
import { hasBinary, invokeAgent } from "./providers.js";
import { executePrompt, planPrompt, reviewPrompt } from "./prompts.js";
import { assertReferenceFilesUnchanged, assertReferenceStable, captureReferenceFiles, referenceEvidence, referenceFingerprint, resolveReference, specFromPrompt } from "./references.js";
import { validateSpecification } from "./spec.js";
import { childProcessEnvironment } from "./environment.js";
import type { CheckResult, Config, Provider, ReferenceRepo, Run } from "./types.js";

const usage = `Code Agent Workflow — repository-independent, human-gated coding workflow

Commands (run from inside a Git project):
  caw init                           Create local project configuration and example spec
  caw doctor                         Check project and agent CLIs
  caw plan <spec.md> [--provider codex|claude]
  caw plan --prompt "<request>" [--reference <repo>] [--provider codex|claude]
  caw approve <run-id>               Human review gate: approve plan to execute
  caw run <run-id>                   Implement in isolated Git worktree
  caw verify <run-id>                Run configured validation commands
  caw review <run-id> [--provider codex|claude]
  caw report <run-id>                Write evidence report
  caw status                         Show recent run IDs and stages
  caw metrics                        Aggregate outcomes for evaluation

The CLI NEVER automatically pushes, merges, or deploys. Worktrees are NOT security sandboxes.`;

function requireProvider(candidate: string | undefined, fallback: Provider): Provider {
  const value = candidate ?? fallback;
  if (value !== "codex" && value !== "claude") throw new Error(`Invalid provider: ${value}`);
  return value;
}
function option(args: string[], flag: string): string | undefined {
  const values = options(args, flag);
  if (values.length > 1) throw new Error(`Repeat ${flag} only when multiple values are supported`);
  return values[0];
}
function options(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== flag) continue;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value after ${flag}`);
    values.push(value);
    index++;
  }
  return values;
}
function positionalArgs(args: string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--provider" || arg === "--prompt" || arg === "--reference") {
      if (!args[index + 1] || args[index + 1]!.startsWith("--")) throw new Error(`Missing value after ${arg}`);
      index++;
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
    values.push(arg);
  }
  return values;
}
function localFile(repo: string, file: string): string {
  const resolved = path.resolve(repo, file);
  if (!(resolved === repo || resolved.startsWith(repo + path.sep))) throw new Error("Specification must be inside the repository");
  if (existsSync(resolved) && !realpathSync(resolved).startsWith(repo + path.sep)) throw new Error("Specification cannot be a symlink outside the repository");
  return resolved;
}
function content(filename: string): string { return readFileSync(filename, "utf8"); }
function targetFile(run: Run, filename: string): string { return path.join(runDir(run.repoRoot, run.id), filename); }
function writeLocal(filename: string, text: string): void { writeFileSync(filename, text, { mode: 0o600 }); }
function needStage(run: Run, ...allowed: Run["stage"][]): void {
  if (!allowed.includes(run.stage)) throw new Error(`Run ${run.id} is '${run.stage}', expected: ${allowed.join(" / ")}`);
}
function requireWorktree(run: Run): string {
  if (!run.worktree || !existsSync(run.worktree)) throw new Error("Worktree not found; inspect the run state and Git worktree list");
  return run.worktree;
}

function init(repo: string): void {
  const configFile = path.join(repo, CONFIG_NAME);
  if (existsSync(configFile)) throw new Error(`${CONFIG_NAME} already exists; won't overwrite it`);
  const verify: string[][] = [];
  const packageFile = path.join(repo, "package.json");
  if (existsSync(packageFile)) {
    const pkg = JSON.parse(content(packageFile)) as {scripts?: Record<string, string>};
    for (const script of ["typecheck", "lint", "test:ci", "build"]) {
      if (pkg.scripts?.[script]) verify.push(["npm", "run", script]);
    }
    if (pkg.scripts?.test && !pkg.scripts["test:ci"]) verify.push(["npm", "test"]);
  }
  const cfg: Config = { schemaVersion: 1, defaultProvider: "codex", verify, executionTimeoutMinutes: 20, maxSpecBytes: 50000 };
  writeFileSync(configFile, JSON.stringify(cfg, null, 2) + "\n");
  appendIgnore(repo);
  const specDir = path.join(repo, "specs");
  mkdirSync(specDir, { recursive: true });
  const specFile = path.join(specDir, "example-feature.md");
  if (!existsSync(specFile)) writeFileSync(specFile, `# Example feature specification\n\n## Objective\nDescribe the user problem and measurable outcome.\n\n## Scope\nWhat should change, and what should not?\n\n## Acceptance criteria\n- [ ] Define observable user-facing behavior.\n- [ ] Define error and loading behavior as applicable.\n- [ ] Tests cover core behavior and regressions.\n\n## Constraints\nFollow this repository's architecture and accessibility conventions.\n\n## Verification\nDescribe expected tests or manual checks.\n`);
  console.log(`Initialized ${CONFIG_NAME} and ${path.relative(repo, specFile)}.`);
  console.log("Next: edit verification commands + spec; commit config/spec first; then run caw plan specs/example-feature.md");
}

async function doctor(repo: string): Promise<void> {
  const config = loadConfig(repo);
  console.log(`Project: ${repo}\nNode: ${process.version}\nGit HEAD: ${git(repo, ["rev-parse", "--short", "HEAD"])}`);
  console.log(`Codex CLI: ${hasBinary(process.env.CAW_CODEX_BIN || "codex") ? "found" : "not found"}`);
  console.log(`Claude CLI: ${hasBinary(process.env.CAW_CLAUDE_BIN || "claude") ? "found" : "not found"}`);
  console.log(`Default: ${config.defaultProvider}; verify commands: ${config.verify.length}`);
  if (config.verify.length === 0) console.log("WARNING: Configure nonempty verify commands to make the verification gate meaningful.");
  console.log("Safety: only use trusted repositories; a Git worktree isolates changes, not shell processes or secrets.");
}

async function withStableReferences<T>(references: ReferenceRepo[], action: () => Promise<T>): Promise<T> {
  const before = references.map(reference => referenceFingerprint(reference));
  try {
    return await action();
  } finally {
    assertReferenceStable(references, before);
  }
}

async function plan(repo: string, args: string[]): Promise<void> {
  const config = loadConfig(repo);
  const prompt = option(args, "--prompt");
  const specArgs = positionalArgs(args);
  if (prompt && specArgs.length > 0) throw new Error("Use either a specification file or --prompt, not both");
  if (!prompt && specArgs.length !== 1) throw new Error('Usage: caw plan <spec.md> [--provider codex|claude] or caw plan --prompt "<request>" [--reference <repo>] [--provider codex|claude]');
  assertClean(repo);
  const references = options(args, "--reference").map(reference => resolveReference(process.cwd(), reference, repo));
  const referenceRoots = new Set<string>();
  for (const reference of references) {
    if (referenceRoots.has(reference.path)) throw new Error(`Duplicate reference repository: ${reference.path}`);
    referenceRoots.add(reference.path);
  }
  let spec: string;
  let specSource: string;
  if (prompt) {
    if (!prompt.trim()) throw new Error("Empty prompt");
    spec = specFromPrompt(prompt, references);
    specSource = "prompt";
  } else {
    const specFile = localFile(repo, specArgs[0]!);
    if (!existsSync(specFile)) throw new Error(`Specification not found: ${specFile}`);
    spec = content(specFile);
    specSource = path.relative(repo, specFile);
  }
  if (Buffer.byteLength(spec) > config.maxSpecBytes) throw new Error(`Specification too large; max ${config.maxSpecBytes} bytes`);
  if (!spec.trim()) throw new Error("Empty specification");
  const issues = validateSpecification(spec);
  if (issues.length > 0) throw new Error(`Specification is not ready to plan:\n${issues.map(issue => `- ${issue}`).join("\n")}`);
  const provider = requireProvider(option(args, "--provider"), config.defaultProvider);
  const id = newId();
  const branch = `caw/${id}`;
  const run: Run = {
    schemaVersion: 1, id, specSource, specHash: hashText(spec), references,
    provider, stage: "planned", repoRoot: repo, baseCommit: git(repo, ["rev-parse", "HEAD"]), branch,
    createdAt: new Date().toISOString(), eventLog: []
  };
  saveRun(run);
  writeLocal(targetFile(run, "spec.md"), spec);
  record(run, "planning_started", `provider=${provider}; references=${references.map(reference => reference.path).join(",") || "none"}`);
  if (!hasBinary(process.env[provider === "codex" ? "CAW_CODEX_BIN" : "CAW_CLAUDE_BIN"] || provider)) throw new Error(`Missing ${provider} CLI. Check caw doctor and install/login first.`);
  let result;
  try {
    result = await withStableReferences(references, () => invokeAgent(provider, "plan", planPrompt(spec, references), repo, targetFile(run, "plan-agent.log"), config.executionTimeoutMinutes, references.map(reference => reference.path)));
  } catch (error) {
    record(run, "planning_failed", error instanceof Error ? error.message : String(error));
    throw error;
  }
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    record(run, "planning_failed", `exit=${result.exitCode}`);
    throw new Error(`Planning agent failed (exit ${result.exitCode}); see ${targetFile(run, "plan-agent.log")}`);
  }
  try {
    run.referenceFiles = captureReferenceFiles(result.stdout, references);
  } catch (error) {
    record(run, "planning_failed", error instanceof Error ? error.message : String(error));
    throw error;
  }
  writeLocal(targetFile(run, "plan.md"), result.stdout);
  record(run, "plan_ready", `${run.referenceFiles.length} reference file${run.referenceFiles.length === 1 ? "" : "s"}`);
  console.log(`\nPlan ready: ${targetFile(run, "plan.md")}\nRun ID: ${id}`);
  for (const reference of references) console.log(`Reference: ${reference.path} @ ${reference.commit}`);
  console.log(`Review plan, then: caw approve ${id}`);
}

function approve(repo: string, id: string): void {
  const run = loadRun(repo, id);
  needStage(run, "planned");
  if (!existsSync(targetFile(run, "plan.md"))) throw new Error("No completed plan to approve");
  if (hashText(content(targetFile(run, "spec.md"))) !== run.specHash) throw new Error("Specification snapshot modified since planning");
  if (git(repo, ["rev-parse", "HEAD"]) !== run.baseCommit) throw new Error("Repository HEAD changed since planning; replan for fresh base");
  assertReferenceFilesUnchanged(run.referenceFiles ?? []);
  assertClean(repo);
  run.approvedPlanHash = hashText(content(targetFile(run, "plan.md")));
  run.approvedConfigHash = hashText(content(path.join(repo, CONFIG_NAME)));
  run.stage = "approved";
  run.approvedAt = new Date().toISOString();
  record(run, "human_approved");
  console.log(`Approved ${id}. Next: caw run ${id}`);
}

async function implement(repo: string, id: string): Promise<void> {
  const config = loadConfig(repo);
  const run = loadRun(repo, id);
  needStage(run, "approved");
  if (git(repo, ["rev-parse", "HEAD"]) !== run.baseCommit) throw new Error("HEAD changed since approval; replan for fresh base");
  if (hashText(content(targetFile(run, "plan.md"))) !== run.approvedPlanHash) throw new Error("Approved plan changed since approval; start a new run");
  if (hashText(content(targetFile(run, "spec.md"))) !== run.specHash) throw new Error("Specification changed since approval; start a new run");
  assertClean(repo);
  if (hashText(content(path.join(repo, CONFIG_NAME))) !== run.approvedConfigHash) throw new Error("Project configuration changed since approval; start a new run");
  const evidence = referenceEvidence(run.referenceFiles ?? []);
  if (!hasBinary(process.env[run.provider === "codex" ? "CAW_CODEX_BIN" : "CAW_CLAUDE_BIN"] || run.provider)) throw new Error(`Missing ${run.provider} CLI. Check caw doctor.`);
  const dirname = path.basename(repo);
  const worktree = path.resolve(repo, "..", `.${dirname}-caw-worktrees`, run.id);
  if (existsSync(worktree)) throw new Error(`Worktree path exists: ${worktree}`);
  mkdirSync(path.dirname(worktree), { recursive: true });
  git(repo, ["worktree", "add", "-b", run.branch, worktree, run.baseCommit]);
  run.worktree = worktree;
  record(run, "worktree_created", worktree);
  const spec = content(targetFile(run, "spec.md"));
  const approvedPlan = content(targetFile(run, "plan.md"));
  let result;
  try {
    result = await withStableReferences(run.references ?? [], () => invokeAgent(run.provider, "execute", executePrompt(spec, approvedPlan, evidence), worktree, targetFile(run, "execution-agent.log"), config.executionTimeoutMinutes));
  } catch (error) {
    run.executionExitCode = 1;
    run.executedAt = new Date().toISOString();
    run.stage = "execution_failed";
    record(run, "execution_failed", error instanceof Error ? error.message : String(error));
    throw error;
  }
  run.executionExitCode = result.exitCode;
  run.executedAt = new Date().toISOString();
  run.stage = result.exitCode === 0 ? "executed" : "execution_failed";
  record(run, result.exitCode === 0 ? "execution_completed" : "execution_failed", `exit=${result.exitCode}; durationMs=${result.durationMs}`);
  console.log(`Worktree: ${worktree}\nBranch: ${run.branch}`);
  if (result.exitCode !== 0) throw new Error(`Execution failed; changes kept for inspection. See ${targetFile(run, "execution-agent.log")}`);
  console.log(`Next: caw verify ${id}`);
}

async function runCommand(args: string[], cwd: string, logFile: string, timeoutMinutes: number): Promise<CheckResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(args[0]!, args.slice(1), {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: childProcessEnvironment("verification"),
    });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let completed = false;
    const timeout = setTimeout(() => child.kill("SIGTERM"), timeoutMinutes * 60 * 1000);
    child.stdout.on("data", (b: Buffer) => stdout.push(b));
    child.stderr.on("data", (b: Buffer) => stderr.push(b));
    child.once("error", err => { if (completed) return; completed = true; clearTimeout(timeout); reject(err); });
    child.once("close", (code, signal) => {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      const exitCode = signal ? 124 : (code ?? 1);
      const output = `command=${args.join(" ")} exit=${exitCode}\n--- STDOUT ---\n${Buffer.concat(stdout).toString("utf8")}\n--- STDERR ---\n${Buffer.concat(stderr).toString("utf8")}`;
      writeLocal(logFile, output);
      resolve({ command: args, exitCode, durationMs: Date.now() - started, log: logFile });
    });
  });
}

async function verify(repo: string, id: string): Promise<void> {
  const cfg = loadConfig(repo);
  const run = loadRun(repo, id);
  needStage(run, "executed", "verification_failed", "verified");
  const worktree = requireWorktree(run);
  if (hashText(content(path.join(repo, CONFIG_NAME))) !== run.approvedConfigHash) throw new Error("Verification configuration changed since plan approval; start a fresh run.");
  if (cfg.verify.length === 0) throw new Error(`No verification commands configured. Add commands to ${CONFIG_NAME}`);
  const checks: CheckResult[] = [];
  for (let i = 0; i < cfg.verify.length; i++) {
    const cmd = cfg.verify[i]!;
    console.log(`Checking [${i+1}/${cfg.verify.length}]: ${cmd.join(" ")}`);
    const check = await runCommand(cmd, worktree, targetFile(run, `verify-${i+1}.log`), cfg.executionTimeoutMinutes);
    checks.push(check);
    console.log(`  exit=${check.exitCode} (${check.durationMs}ms)`);
    if (check.exitCode !== 0) break;
  }
  run.checkResults = checks;
  run.verifiedWorktreeHash = checks.length === cfg.verify.length && checks.every(x => x.exitCode === 0) ? worktreeHash(worktree, run.baseCommit) : undefined;
  run.verifiedAt = new Date().toISOString();
  run.stage = checks.length === cfg.verify.length && checks.every(x => x.exitCode === 0) ? "verified" : "verification_failed";
  record(run, run.stage, `${checks.filter(x => x.exitCode === 0).length}/${cfg.verify.length} passed`);
  if (run.stage !== "verified") throw new Error(`Verification failed. Inspect logs and fix worktree; caw verify ${id} retries the checks.`);
  console.log(`Verified. Next: caw review ${id}`);
}

async function review(repo: string, id: string, args: string[]): Promise<void> {
  const cfg = loadConfig(repo);
  const run = loadRun(repo, id);
  needStage(run, "verified", "review_failed", "reviewed");
  const worktree = requireWorktree(run);
  const provider = requireProvider(option(args, "--provider"), run.provider);
  if (hashText(content(path.join(repo, CONFIG_NAME))) !== run.approvedConfigHash) throw new Error("Configuration drifted since approval");
  if (!run.verifiedWorktreeHash || run.verifiedWorktreeHash !== worktreeHash(worktree, run.baseCommit)) throw new Error("Code changed after verification. Run caw verify again before review.");
  // Independent model session, not the implementer's conversation.
  const diff = git(worktree, ["diff", "--no-ext-diff", run.baseCommit]);
  const untracked = git(worktree, ["ls-files", "--others", "--exclude-standard"]);
  const references = run.references ?? [];
  assertReferenceFilesUnchanged(run.referenceFiles ?? []);
  const prompt = reviewPrompt(content(targetFile(run, "spec.md")), content(targetFile(run, "plan.md")), references) +
    `\nBase commit for diff: ${run.baseCommit}\n` +
    `\n<git-diff truncated="${diff.length > 120000}">\n${diff.slice(0, 120000)}\n</git-diff>` +
    `\n<untracked-files>\n${untracked}\n</untracked-files>\n` +
    `\nUse file read tools to inspect any untracked source files and understand context.`;
  if (!hasBinary(process.env[provider === "codex" ? "CAW_CODEX_BIN" : "CAW_CLAUDE_BIN"] || provider)) throw new Error(`Missing ${provider} CLI. Check caw doctor.`);
  const result = await withStableReferences(references, () => invokeAgent(provider, "review", prompt, worktree, targetFile(run, "review-agent.log"), cfg.executionTimeoutMinutes, references.map(reference => reference.path)));
  run.reviewProvider = provider;
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    run.stage = "review_failed";
    record(run, "review_failed", `exit=${result.exitCode}`);
    throw new Error("Review agent failed; see review-agent.log");
  }
  writeLocal(targetFile(run, "review.md"), result.stdout);
  run.reviewedAt = new Date().toISOString();
  run.stage = "reviewed";
  record(run, "review_delivered", `provider=${provider}; advisory review, not automatic approval`);
  console.log(`Independent review saved: ${targetFile(run, "review.md")}`);
  console.log(`Next: caw report ${id}. A human must assess findings before any merge.`);
}

function report(repo: string, id: string): void {
  const run = loadRun(repo, id);
  const worktree = run.worktree && existsSync(run.worktree) ? run.worktree : null;
  const status = worktree ? git(worktree, ["status", "--short"]) : "(no worktree yet)";
  const changed = worktree ? git(worktree, ["diff", "--stat", run.baseCommit]) : "";
  const reportText = `# Code Agent Workflow Evidence Report\n\n` +
    `- Run: ${run.id}\n- Stage: ${run.stage}\n- Spec source: ${run.specSource}\n- Spec SHA256: ${run.specHash}\n` +
    `- Base commit: ${run.baseCommit}\n- Provider: ${run.provider}\n- Review provider: ${run.reviewProvider || "not run"}\n` +
    `- Human approval recorded: ${run.approvedAt || "NO"}\n- Approved configuration SHA256: ${run.approvedConfigHash || "not approved"}\n- Approved plan SHA256: ${run.approvedPlanHash || "not approved"}\n- Verified worktree SHA256: ${run.verifiedWorktreeHash || "not verified"}\n- Branch: ${run.branch}\n- Worktree: ${run.worktree || "not created"}\n\n` +
    `## Reference repositories\n` + (run.references?.length ? run.references.map(reference => `- ${reference.path} @ ${reference.commit}${reference.dirty ? " (dirty at planning)" : ""}`).join("\n") : "- None") +
    `\n\n## Reference files\n` + (run.referenceFiles?.length ? run.referenceFiles.map(file => `- \`${file.path}\` \`${file.sha256}\``).join("\n") : "- None") + "\n\n" +
    `## Verification\n` + (run.checkResults?.length ? run.checkResults.map(c => `- \`${c.command.join(" ")}\`: ${c.exitCode === 0 ? "PASS" : "FAIL"} (${c.durationMs} ms)`).join("\n") : "No verification recorded") +
    `\n\n## Change status\n\n\`\`\`\n${status || "(clean)"}\n\`\`\`\n\n## Diff summary (tracked files)\n\n\`\`\`\n${changed || "(none)"}\n\`\`\`\n\n` +
    `## Events\n` + run.eventLog.map(e => `- ${e.at}: ${e.event}${e.note ? ` — ${e.note}` : ""}`).join("\n") +
    `\n\n## Artifacts\n\n- spec.md, plan.md, execution-agent.log, review.md (if available), verify-*.log\n` +
    `\n**Advisory only:** A passing check and an LLM reviewer do not replace human review, security inspection, and normal CI. No merge, push, deployment, or PR was performed by this tool.\n`;
  const file = targetFile(run, "REPORT.md");
  writeLocal(file, reportText);
  console.log(`Report: ${file}`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || ["help", "--help", "-h"].includes(command)) return console.log(usage);
  const repo = repoRoot();
  switch (command) {
    case "init": return init(repo);
    case "doctor": return doctor(repo);
    case "plan": return plan(repo, args);
    case "approve": if (!args[0]) throw new Error("Missing run ID"); return approve(repo, args[0]);
    case "run": if (!args[0]) throw new Error("Missing run ID"); return implement(repo, args[0]);
    case "verify": if (!args[0]) throw new Error("Missing run ID"); return verify(repo, args[0]);
    case "review": if (!args[0]) throw new Error("Missing run ID"); return review(repo, args[0], args);
    case "report": if (!args[0]) throw new Error("Missing run ID"); return report(repo, args[0]);
    case "metrics": {
      const all = listRunIds(repo).map(id => loadRun(repo, id));
      const tally: Record<string, number> = {};
      for (const run of all) tally[run.stage] = (tally[run.stage] ?? 0) + 1;
      const executed = all.filter(r => Boolean(r.executedAt)).length;
      const verified = all.filter(r => Boolean(r.verifiedAt) && (r.stage === "verified" || r.stage === "reviewed")).length;
      console.log(JSON.stringify({ totalRuns: all.length, executionAttempts: executed, verifiedRuns: verified,
        independentReviewsCompleted: all.filter(r => r.stage === "reviewed").length,
        verificationPassRateAmongExecutionAttempts: executed ? Number((verified / executed).toFixed(3)) : null,
        stages: tally, caveat: "Not a model-quality benchmark: compare identical tasks, capture cost/time, and independently score outcomes." }, null, 2));
      return;
    }
    case "status": {
      const runs = listRunIds(repo);
      if (!runs.length) return console.log("No runs. Start with caw plan <spec.md>");
      for (const id of runs.slice(0, 15)) { const run = loadRun(repo, id); console.log(`${id}  ${run.stage.padEnd(20)}  ${run.specSource}`); }
      return;
    }
    default: throw new Error(`Unknown command: ${command}\n\n${usage}`);
  }
}
main().catch(err => { console.error(`Error: ${err instanceof Error ? err.message : String(err)}`); process.exitCode = 1; });
