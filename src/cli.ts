#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { appendIgnore, assertClean, CONFIG_NAME, git, hashText, listRunIds, loadConfig, loadRun, newId, record, repoRoot, runDir, saveRun, worktreeHash } from "./paths.js";
import { canonicalPlanJson, PLAN_JSON_SCHEMA, PlanValidationError, renderPlan, validatePlan } from "./plan.js";
import { extractPlanDocument, extractReviewDocument, hasBinary, invokeAgent, type StructuredOutputRequest } from "./providers.js";
import { canonicalReviewJson, CRITERION_STATUSES, FINDING_SEVERITIES, renderReview, REVIEW_JSON_SCHEMA, REVIEW_VERDICTS, reviewDiffPrompt, reviewLocation, ReviewValidationError, validateReview, type CodeReview, type ReviewEvidence, type ReviewVerdict } from "./review.js";
import { executePrompt, planPrompt, reviewPrompt, verificationEvidencePrompt } from "./prompts.js";
import { assertReferenceFilesUnchanged, assertReferenceStable, referenceEvidence, referenceFingerprint, resolveReference, specFromPrompt } from "./references.js";
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
function failPlanning(run: Run, error: unknown): void {
  run.stage = "planning_failed";
  record(run, "planning_failed", error instanceof Error ? error.message : String(error));
}
interface DeliveredReview {
  kind: "structured" | "legacy";
  reviewProvider?: Provider;
  reviewedAt?: string;
  reviewJsonHash?: string;
  reviewMarkdownHash?: string;
  reviewDiffTruncated?: boolean;
  reviewDiffSha256?: string;
  reviewUntrackedTruncated?: boolean;
}
function deliveredReview(run: Run): DeliveredReview | undefined {
  if (run.stage !== "reviewed") return undefined;
  const markdownPath = targetFile(run, "review.md");
  const jsonPath = targetFile(run, "review.json");
  if (run.reviewFormat === "structured" && run.reviewJsonHash && run.reviewMarkdownHash && existsSync(jsonPath) && existsSync(markdownPath)) {
    return {
      kind: "structured",
      reviewProvider: run.reviewProvider,
      reviewedAt: run.reviewedAt,
      reviewJsonHash: run.reviewJsonHash,
      reviewMarkdownHash: run.reviewMarkdownHash,
      reviewDiffTruncated: run.reviewDiffTruncated,
      reviewDiffSha256: run.reviewDiffSha256,
      reviewUntrackedTruncated: run.reviewUntrackedTruncated,
    };
  }
  if (run.reviewFormat === undefined && existsSync(markdownPath) && !existsSync(jsonPath)) {
    return {kind: "legacy", reviewProvider: run.reviewProvider, reviewedAt: run.reviewedAt};
  }
  return undefined;
}
function restoreDeliveredMetadata(run: Run, delivered: DeliveredReview): void {
  run.stage = "reviewed";
  if (delivered.reviewProvider === undefined) delete run.reviewProvider;
  else run.reviewProvider = delivered.reviewProvider;
  if (delivered.reviewedAt === undefined) delete run.reviewedAt;
  else run.reviewedAt = delivered.reviewedAt;
  if (delivered.kind === "legacy") {
    delete run.reviewFormat;
    delete run.reviewJsonHash;
    delete run.reviewMarkdownHash;
    delete run.reviewDiffTruncated;
    delete run.reviewDiffSha256;
    delete run.reviewUntrackedTruncated;
    return;
  }
  run.reviewFormat = "structured";
  run.reviewJsonHash = delivered.reviewJsonHash;
  run.reviewMarkdownHash = delivered.reviewMarkdownHash;
  if (delivered.reviewDiffTruncated === undefined) delete run.reviewDiffTruncated;
  else run.reviewDiffTruncated = delivered.reviewDiffTruncated;
  if (delivered.reviewDiffSha256 === undefined) delete run.reviewDiffSha256;
  else run.reviewDiffSha256 = delivered.reviewDiffSha256;
  if (delivered.reviewUntrackedTruncated === undefined) delete run.reviewUntrackedTruncated;
  else run.reviewUntrackedTruncated = delivered.reviewUntrackedTruncated;
}
function discardReviewAttempt(run: Run): void {
  for (const name of ["review.json.next", "review.md.next"]) {
    const file = targetFile(run, name);
    if (existsSync(file)) unlinkSync(file);
  }
}
function failReview(run: Run, error: unknown, delivered?: DeliveredReview): Error {
  discardReviewAttempt(run);
  const note = error instanceof Error ? error.message : String(error);
  if (delivered) {
    restoreDeliveredMetadata(run, delivered);
    const kept = `${note} The previously delivered review was left unchanged.`;
    record(run, "review_failed", kept);
    return new Error(kept);
  }
  for (const name of ["review.json", "review.md"]) {
    const file = targetFile(run, name);
    if (existsSync(file)) unlinkSync(file);
  }
  delete run.reviewFormat;
  delete run.reviewJsonHash;
  delete run.reviewMarkdownHash;
  delete run.reviewDiffTruncated;
  delete run.reviewDiffSha256;
  delete run.reviewUntrackedTruncated;
  delete run.reviewedAt;
  run.stage = "review_failed";
  record(run, "review_failed", note);
  return new Error(note);
}
function publishReviewArtifacts(run: Run, json: string, markdown: string): void {
  const jsonPath = targetFile(run, "review.json");
  const markdownPath = targetFile(run, "review.md");
  const jsonNext = `${jsonPath}.next`;
  const markdownNext = `${markdownPath}.next`;
  writeLocal(jsonNext, json);
  writeLocal(markdownNext, markdown);
  const previousJson = existsSync(jsonPath) ? readFileSync(jsonPath) : undefined;
  const previousMarkdown = existsSync(markdownPath) ? readFileSync(markdownPath) : undefined;
  const restore = (filename: string, previous: Buffer | undefined) => {
    if (previous === undefined) {
      if (existsSync(filename)) unlinkSync(filename);
      return;
    }
    writeFileSync(filename, previous, {mode: 0o600});
  };
  try {
    renameSync(jsonNext, jsonPath);
    renameSync(markdownNext, markdownPath);
  } catch (error) {
    restore(jsonPath, previousJson);
    restore(markdownPath, previousMarkdown);
    discardReviewAttempt(run);
    throw error;
  }
}
function expectedCriterionIds(run: Run): string[] {
  readApprovedPlan(run);
  if (planFormatOf(run) === "legacy") return [];
  const parsed = JSON.parse(content(targetFile(run, "plan.json"))) as unknown;
  return validatePlan(parsed, run.references ?? []).plan.acceptanceCriteria.map(criterion => criterion.id);
}
function planFormatOf(run: Run): "structured" | "legacy" {
  const format = (run as {planFormat?: unknown}).planFormat;
  if (format === undefined || format === null) return "legacy";
  if (format === "structured") return "structured";
  throw new Error(`Unsupported plan format: ${String(format)}. This harness accepts structured plans and older Markdown-only runs.`);
}
function unchangedStructuredPlan(run: Run): {json: string; markdown: string} {
  const jsonPath = targetFile(run, "plan.json");
  const markdownPath = targetFile(run, "plan.md");
  if (!existsSync(jsonPath)) throw new Error("Structured plan is missing plan.json");
  if (!existsSync(markdownPath)) throw new Error("Structured plan is missing plan.md");
  if (!run.planJsonHash || !run.planMarkdownHash) throw new Error("Structured plan is missing the snapshot recorded at planning. Start a new run.");
  const json = content(jsonPath);
  const markdown = content(markdownPath);
  if (hashText(json) !== run.planJsonHash) throw new Error("plan.json changed since planning. Start a new run.");
  if (hashText(markdown) !== run.planMarkdownHash) throw new Error("plan.md changed since planning. Start a new run.");
  assertStructuredDocuments(run, json, markdown);
  return {json, markdown};
}
function assertStructuredDocuments(run: Run, json: string, markdown: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`plan.json is not valid JSON (${detail}). Start a new run.`);
  }
  const listed = referenceEntries(parsed);
  const captured = run.referenceFiles ?? [];
  const matches = listed.length === captured.length && listed.every((item, index) => {
    const file = captured[index];
    return file !== undefined && file.repository === item.repository && file.path === item.path;
  });
  if (!matches) throw new Error("plan.json reference files do not match the evidence captured during planning. Start a new run.");
  let validated;
  try {
    validated = validatePlan(parsed, run.references ?? []);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Structured plan is not valid. Start a new run.\n${detail}`);
  }
  if (renderPlan(validated.plan) !== markdown) throw new Error("plan.md does not match plan.json. Start a new run.");
}
function referenceEntries(parsed: unknown): Array<{repository: string; path: string}> {
  if (!isPlanRecord(parsed) || !Array.isArray(parsed.referenceFiles)) {
    throw new Error("plan.json reference files do not match the evidence captured during planning. Start a new run.");
  }
  return parsed.referenceFiles.map(item => {
    if (!isPlanRecord(item) || typeof item.repository !== "string" || typeof item.path !== "string") {
      throw new Error("plan.json reference files do not match the evidence captured during planning. Start a new run.");
    }
    return {repository: item.repository, path: item.path};
  });
}
function isPlanRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readApprovedPlan(run: Run): string {
  const markdownPath = targetFile(run, "plan.md");
  if (!existsSync(markdownPath)) throw new Error("Approved plan.md is missing; start a new run");
  const markdown = content(markdownPath);
  if (hashText(markdown) !== run.approvedPlanHash) throw new Error("Approved plan changed since approval; start a new run");
  if (planFormatOf(run) === "structured") {
    const jsonPath = targetFile(run, "plan.json");
    if (!existsSync(jsonPath)) throw new Error("Approved plan.json is missing; start a new run");
    const json = content(jsonPath);
    if (!run.planJsonHash || !run.planMarkdownHash) throw new Error("Structured plan is missing the snapshot recorded at planning. Start a new run.");
    if (!run.approvedPlanJsonHash) throw new Error("Structured plan is missing its approved plan.json hash; start a new run");
    if (hashText(json) !== run.approvedPlanJsonHash) throw new Error("Approved plan.json changed since approval; start a new run");
    if (run.approvedPlanJsonHash !== run.planJsonHash || run.approvedPlanHash !== run.planMarkdownHash) {
      throw new Error("Approved plan does not match the snapshot recorded at planning. Start a new run.");
    }
    assertStructuredDocuments(run, json, markdown);
  }
  return markdown;
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
  console.log("Plans: new runs write schema version 1 to plan.json and generate plan.md. Older runs that only have plan.md still approve and execute.");
  console.log("Reviews: new reviews write schema version 1 to review.json and generate review.md. The verdict is advisory. Older runs that only have review.md stay readable and are not treated as a validated verdict.");
  console.log("Safety: only use trusted repositories; a Git worktree isolates changes, not shell processes or secrets.");
  console.log("MCP: Claude requests --strict-mcp-config and denies mcp__*. Codex requests --ignore-user-config and refuses readable project or host MCP configuration. A passing local check does not cover cloud-managed Codex configuration, macOS managed preferences, or remote Claude managed MCP settings.");
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
    provider, stage: "planned", planFormat: "structured", repoRoot: repo, baseCommit: git(repo, ["rev-parse", "HEAD"]), branch,
    createdAt: new Date().toISOString(), eventLog: []
  };
  saveRun(run);
  writeLocal(targetFile(run, "spec.md"), spec);
  const schemaPath = targetFile(run, "plan.schema.json");
  const lastMessagePath = targetFile(run, "plan-last-message.json");
  const logFile = targetFile(run, "plan-agent.log");
  writeLocal(schemaPath, `${JSON.stringify(PLAN_JSON_SCHEMA, null, 2)}\n`);
  record(run, "planning_started", `provider=${provider}; references=${references.map(reference => reference.path).join(",") || "none"}`);
  const structured: StructuredOutputRequest = {schemaPath, schema: PLAN_JSON_SCHEMA, lastMessagePath};
  if (!hasBinary(process.env[provider === "codex" ? "CAW_CODEX_BIN" : "CAW_CLAUDE_BIN"] || provider)) {
    const message = `Missing ${provider} CLI. Check caw doctor and install/login first.`;
    failPlanning(run, message);
    throw new Error(message);
  }
  let result;
  try {
    result = await withStableReferences(references, () => invokeAgent(provider, "plan", planPrompt(spec, references), repo, logFile, config.executionTimeoutMinutes, references.map(reference => reference.path), structured));
  } catch (error) {
    failPlanning(run, error);
    throw error;
  }
  if (result.exitCode !== 0) {
    const message = `Planning agent failed (exit ${result.exitCode}); see ${logFile}. Structured planning requires Codex --output-schema and --output-last-message, or Claude --output-format json and --json-schema. Provider diagnostics were not accepted as a plan.`;
    failPlanning(run, message);
    throw new Error(message);
  }
  try {
    const document = extractPlanDocument(provider, result.stdout, lastMessagePath);
    const validated = validatePlan(document, references);
    const json = canonicalPlanJson(validated.plan);
    const markdown = renderPlan(validated.plan);
    run.referenceFiles = validated.referenceFiles;
    run.planJsonHash = hashText(json);
    run.planMarkdownHash = hashText(markdown);
    writeLocal(targetFile(run, "plan.json"), json);
    writeLocal(targetFile(run, "plan.md"), markdown);
  } catch (error) {
    const detail = error instanceof PlanValidationError
      ? `Planning output is not a valid structured plan:\n${error.message}`
      : error instanceof Error ? error.message : String(error);
    const message = `${detail}\nSee ${logFile}.`;
    failPlanning(run, message);
    throw new Error(message);
  }
  record(run, "plan_ready", `${run.referenceFiles?.length ?? 0} reference file${run.referenceFiles?.length === 1 ? "" : "s"}`);
  console.log(`\nPlan ready: ${targetFile(run, "plan.md")}`);
  console.log(`Structured plan: ${targetFile(run, "plan.json")}`);
  console.log(`Run ID: ${id}`);
  for (const reference of references) console.log(`Reference: ${reference.path} @ ${reference.commit}`);
  console.log(`Review plan, then: caw approve ${id}`);
}

function approve(repo: string, id: string): void {
  const run = loadRun(repo, id);
  needStage(run, "planned");
  const format = planFormatOf(run);
  if (format === "legacy" && !existsSync(targetFile(run, "plan.md"))) throw new Error("No completed plan to approve");
  if (hashText(content(targetFile(run, "spec.md"))) !== run.specHash) throw new Error("Specification snapshot modified since planning");
  if (git(repo, ["rev-parse", "HEAD"]) !== run.baseCommit) throw new Error("Repository HEAD changed since planning; replan for fresh base");
  assertReferenceFilesUnchanged(run.referenceFiles ?? []);
  assertClean(repo);
  if (format === "structured") {
    const plan = unchangedStructuredPlan(run);
    run.approvedPlanHash = hashText(plan.markdown);
    run.approvedPlanJsonHash = hashText(plan.json);
  } else {
    run.approvedPlanHash = hashText(content(targetFile(run, "plan.md")));
  }
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
  const approvedPlan = readApprovedPlan(run);
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
  const verification = verificationEvidence(run, cfg);
  // Independent model session, not the implementer's conversation.
  const diff = git(worktree, ["diff", "--no-ext-diff", run.baseCommit]);
  const untracked = git(worktree, ["ls-files", "--others", "--exclude-standard"]);
  const references = run.references ?? [];
  assertReferenceFilesUnchanged(run.referenceFiles ?? []);
  const approvedPlan = readApprovedPlan(run);
  const criterionIds = expectedCriterionIds(run);
  const diffEvidence = reviewDiffPrompt(diff, run.baseCommit, untracked);
  const prompt = reviewPrompt(content(targetFile(run, "spec.md")), approvedPlan, references, planFormatOf(run) === "legacy" ? undefined : criterionIds) +
    `\nBase commit for diff: ${run.baseCommit}\n` +
    verification +
    diffEvidence.text;
  if (!hasBinary(process.env[provider === "codex" ? "CAW_CODEX_BIN" : "CAW_CLAUDE_BIN"] || provider)) throw new Error(`Missing ${provider} CLI. Check caw doctor.`);
  const delivered = deliveredReview(run);
  const schemaPath = targetFile(run, "review.schema.json");
  const lastMessagePath = targetFile(run, "review-last-message.json");
  const logFile = targetFile(run, "review-agent.log");
  writeLocal(schemaPath, `${JSON.stringify(REVIEW_JSON_SCHEMA, null, 2)}\n`);
  if (existsSync(lastMessagePath)) unlinkSync(lastMessagePath);
  const structured: StructuredOutputRequest = {schemaPath, schema: REVIEW_JSON_SCHEMA, lastMessagePath};
  run.reviewProvider = provider;
  let result;
  try {
    result = await withStableReferences(references, () => invokeAgent(provider, "review", prompt, worktree, logFile, cfg.executionTimeoutMinutes, references.map(reference => reference.path), structured));
  } catch (error) {
    throw failReview(run, error, delivered);
  }
  if (result.exitCode !== 0) {
    const message = `Review agent failed (exit ${result.exitCode}); see ${logFile}. Structured review requires Codex --output-schema and --output-last-message, or Claude --output-format json and --json-schema. Provider diagnostics were not accepted as a review.`;
    throw failReview(run, message, delivered);
  }
  try {
    const document = extractReviewDocument(provider, result.stdout, lastMessagePath);
    const evidence: ReviewEvidence = {
      truncatedDiff: diffEvidence.diffTruncated,
      truncatedUntracked: diffEvidence.untrackedTruncated,
    };
    const validated = validateReview(document, criterionIds, evidence);
    const json = canonicalReviewJson(validated);
    const markdown = renderReview(validated);
    publishReviewArtifacts(run, json, markdown);
    run.reviewFormat = "structured";
    run.reviewJsonHash = hashText(json);
    run.reviewMarkdownHash = hashText(markdown);
    if (diffEvidence.diffTruncated) {
      run.reviewDiffTruncated = true;
      run.reviewDiffSha256 = diffEvidence.diffSha256;
    } else {
      delete run.reviewDiffTruncated;
      delete run.reviewDiffSha256;
    }
    if (diffEvidence.untrackedTruncated) run.reviewUntrackedTruncated = true;
    else delete run.reviewUntrackedTruncated;
    run.reviewedAt = new Date().toISOString();
    run.stage = "reviewed";
    record(run, "review_delivered", `provider=${provider}; verdict=${validated.verdict}; advisory review, not automatic approval`);
    console.log(`Independent review saved: ${targetFile(run, "review.md")}`);
    console.log(`Structured review: ${targetFile(run, "review.json")}`);
    console.log(`Verdict: ${validated.verdict} (advisory; not a merge approval)`);
    console.log(`Next: caw report ${id}. A human must assess findings before any merge.`);
  } catch (error) {
    const detail = error instanceof ReviewValidationError
      ? `Review output is not a valid structured review:\n${error.message}`
      : error instanceof Error ? error.message : String(error);
    const message = `${detail}\nSee ${logFile}.`;
    throw failReview(run, message, delivered);
  }
}

function confirmedVerification(run: Run, approved: readonly string[][]): {command: string[]; exitCode: number; durationMs: number; log: string}[] {
  const checks = run.checkResults;
  if (!run.verifiedAt || !checks || checks.length === 0 || approved.length === 0) {
    throw new Error("Verification evidence is missing for this approved run. caw will not describe it as passing.");
  }
  if (checks.length !== approved.length) {
    throw new Error("Verification evidence does not match the approved commands. caw will not describe it as passing.");
  }
  const rows: {command: string[]; exitCode: number; durationMs: number; log: string}[] = [];
  for (let i = 0; i < approved.length; i++) {
    const expected = approved[i]!;
    const check = checks[i];
    if (!check || !argvMatches(check.command, expected)) {
      throw new Error("Verification evidence does not match the approved commands. caw will not describe it as passing.");
    }
    if (check.exitCode !== 0) {
      throw new Error("Verification evidence does not show that every approved command passed. caw will not describe it as passing.");
    }
    if (typeof check.durationMs !== "number" || !Number.isFinite(check.durationMs) || check.durationMs < 0) {
      throw new Error("Verification evidence is missing for this approved run. caw will not describe it as passing.");
    }
    const log = `verify-${i + 1}.log`;
    if (check.log !== targetFile(run, log) || !existsSync(check.log)) {
      throw new Error("Verification log is missing or does not belong to this run. caw will not describe it as passing.");
    }
    rows.push({command: expected, exitCode: check.exitCode, durationMs: check.durationMs, log});
  }
  return rows;
}
function verificationEvidence(run: Run, cfg: Config): string {
  return verificationEvidencePrompt(confirmedVerification(run, cfg.verify));
}
function worktreeSnapshotProblem(run: Run): string | undefined {
  if (!run.verifiedWorktreeHash) return "No verified worktree snapshot is recorded. caw will not describe verification as passing.";
  if (!run.worktree || !existsSync(run.worktree)) return "The verified worktree is not available, so the snapshot cannot be confirmed. caw will not describe verification as passing.";
  try {
    if (worktreeHash(run.worktree, run.baseCommit) !== run.verifiedWorktreeHash) {
      return "The worktree no longer matches the verified snapshot. caw will not describe verification as passing.";
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return `The verified worktree snapshot could not be checked. ${detail}`;
  }
  return undefined;
}
function verificationReport(run: Run, repo: string): {passed: boolean; detail: string; problems: string[]} {
  const problems: string[] = [];
  const configPath = path.join(repo, CONFIG_NAME);
  const configMatches = Boolean(run.approvedConfigHash) && existsSync(configPath) && hashText(content(configPath)) === run.approvedConfigHash;
  let passed = false;
  let detail = "No verification recorded";
  if (!configMatches) {
    problems.push("Approved configuration no longer matches this run, so the verification commands cannot be confirmed. caw will not describe verification as passing.");
    detail = problems[0]!;
  } else {
    try {
      const rows = confirmedVerification(run, loadConfig(repo).verify);
      passed = true;
      detail = rows.map(check => `- \`${check.command.join(" ")}\`: passed (${check.durationMs} ms)`).join("\n");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      problems.push(message);
      detail = `${message}\n\nRecorded checks:\n${formatRecordedChecks(run)}`;
    }
  }
  const snapshot = worktreeSnapshotProblem(run);
  if (snapshot) {
    passed = false;
    problems.push(snapshot);
    detail = `${detail}\n\n${snapshot}`;
  }
  return {passed, detail, problems};
}
function formatRecordedChecks(run: Run): string {
  if (!run.checkResults?.length) return "No verification recorded";
  return run.checkResults.map(check => {
    const command = Array.isArray(check.command) ? check.command.map(arg => typeof arg === "string" ? arg : "?").join(" ") : "(unreadable command)";
    const exitCode = typeof check.exitCode === "number" ? String(check.exitCode) : "unreadable";
    const duration = typeof check.durationMs === "number" ? String(check.durationMs) : "unreadable";
    return `- \`${command}\`: exit ${exitCode} (${duration} ms)`;
  }).join("\n");
}
function argvMatches(actual: unknown, expected: readonly string[]): boolean {
  return Array.isArray(actual) && actual.length === expected.length && actual.every((arg, index) => typeof arg === "string" && arg === expected[index]);
}
function trackedDiffLine(run: Run): string {
  if (run.reviewDiffTruncated !== true) return "- Tracked diff: complete in the review prompt";
  const provenance = run.reviewDiffSha256
    ? ` Complete-diff SHA-256 ${run.reviewDiffSha256} is diagnostic provenance of the captured diff and does not establish that the omitted changes were inspected.`
    : "";
  return `- Tracked diff: truncated in the review prompt.${provenance}`;
}

function reviewDetails(lines: string[], review: CodeReview, run: Run): void {
  lines.push(trackedDiffLine(run));
  if (run.reviewUntrackedTruncated === true) {
    lines.push("- Untracked files: the prompt listing was truncated. The list does not establish that file contents were inspected.");
  }
  lines.push(`- Findings: ${findingCounts(review)}`);
  lines.push(`- Acceptance criteria: ${coverageCounts(review)}`);
  lines.push("- Artifacts: review.json, review.md");
  if (review.findings.length > 0) {
    lines.push("", "### Finding index");
    for (const finding of FINDING_SEVERITIES.flatMap(severity => review.findings.filter(item => item.severity === severity))) {
      const location = reviewLocation(finding);
      lines.push(`- ${finding.severity} \`${finding.id}\` ${location === "repository-wide" ? location : `\`${location}\``}`);
    }
  }
}
function reviewSection(run: Run, verificationProblems: readonly string[]): string {
  const delivery = run.stage === "reviewed" ? "succeeded" : run.stage === "review_failed" ? "failed" : "not run";
  const lines = [
    "## Review",
    "",
    `- Delivery: ${delivery}`,
    `- Provider: ${run.reviewProvider || "not run"}`,
  ];
  const jsonPath = targetFile(run, "review.json");
  const markdownPath = targetFile(run, "review.md");
  const delivered = readDeliveredReview(run);
  if (run.reviewFormat === "structured" && run.stage === "reviewed") {
    lines.push("- Format: structured (schema version 1)");
    const review = delivered.review;
    const historical = review?.verdict ?? historicalDecision(run);
    if (review && verificationProblems.length === 0) {
      lines.push(`- Reviewer verdict: ${review.verdict}`);
      lines.push("- Current evidence integrity: consistent");
      reviewDetails(lines, review, run);
    } else if (historical) {
      lines.push(`- Historical reviewer decision: ${historical}`);
      lines.push("- Current evidence integrity: inconsistent");
      for (const problem of verificationProblems) lines.push(`- ${problem}`);
      if (delivered.problem) lines.push(`- ${delivered.problem}`);
      lines.push("- The historical reviewer decision is not a currently verified result. These checks do not provide tamper-proof storage.");
      if (review) reviewDetails(lines, review, run);
      else lines.push("- Artifacts: review.json, review.md");
    } else {
      lines.push("- Reviewer verdict: not recorded");
      lines.push(`- ${delivered.problem ?? "Structured review could not be read."}`);
    }
    lines.push("", "Verification passed and a reviewer verdict are different evidence. A reviewer verdict does not approve a merge, push, commit, or deployment.");
  } else if (run.stage === "reviewed" && run.reviewFormat === undefined && existsSync(markdownPath) && !existsSync(jsonPath)) {
    lines.push("- Format: markdown (legacy)");
    lines.push("- Reviewer verdict: not recorded");
    lines.push("- Historical review.md was not validated. Its text is not a structured verdict.");
    lines.push("- Artifacts: review.md");
    lines.push("", "A legacy Markdown review does not approve a merge, push, commit, or deployment.");
  } else {
    lines.push("- Format: none");
    lines.push("- Reviewer verdict: not recorded");
    if (existsSync(markdownPath) || existsSync(jsonPath)) lines.push("- Review files on disk are not a recorded structured verdict.");
  }
  return lines.join("\n");
}

function historicalDecision(run: Run): ReviewVerdict | undefined {
  if (run.reviewFormat !== "structured" || run.stage !== "reviewed" || !run.reviewJsonHash || !run.reviewMarkdownHash) return undefined;
  const jsonPath = targetFile(run, "review.json");
  const markdownPath = targetFile(run, "review.md");
  if (!existsSync(jsonPath) || !existsSync(markdownPath)) return undefined;
  const json = content(jsonPath);
  if (hashText(json) !== run.reviewJsonHash || hashText(content(markdownPath)) !== run.reviewMarkdownHash) return undefined;
  try {
    const parsed = JSON.parse(json) as {verdict?: unknown};
    return (REVIEW_VERDICTS as readonly string[]).includes(String(parsed.verdict)) ? parsed.verdict as ReviewVerdict : undefined;
  } catch {
    return undefined;
  }
}
function readDeliveredReview(run: Run): {review?: CodeReview; problem?: string} {
  if (run.reviewFormat !== "structured" || run.stage !== "reviewed") return {};
  if (!run.reviewJsonHash || !run.reviewMarkdownHash) return {problem: "Structured review is missing the snapshot recorded at delivery."};
  const jsonPath = targetFile(run, "review.json");
  const markdownPath = targetFile(run, "review.md");
  if (!existsSync(jsonPath) || !existsSync(markdownPath)) return {problem: "Structured review artifacts are missing."};
  const json = content(jsonPath);
  const markdown = content(markdownPath);
  if (hashText(json) !== run.reviewJsonHash || hashText(markdown) !== run.reviewMarkdownHash) {
    return {problem: "Review artifacts changed after delivery. The stored verdict was not modified to match them."};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return {problem: "review.json is not valid JSON."};
  }
  let expected: string[];
  try {
    expected = expectedCriterionIds(run);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {problem: `Structured review is not fully validated because the approved plan could not be confirmed. ${detail}`};
  }
  const evidence: ReviewEvidence = {
    truncatedDiff: run.reviewDiffTruncated === true,
    truncatedUntracked: run.reviewUntrackedTruncated === true,
  };
  try {
    const review = validateReview(parsed, expected, evidence);
    if (renderReview(review) !== markdown) return {problem: "review.md does not match review.json."};
    return {review};
  } catch {
    return {problem: "review.json does not match the review schema."};
  }
}

function findingCounts(review: CodeReview): string {
  return FINDING_SEVERITIES.map(severity => `${severity} ${review.findings.filter(finding => finding.severity === severity).length}`).join(", ");
}

function coverageCounts(review: CodeReview): string {
  if (review.acceptanceCriteria.length === 0) return "none supplied";
  return CRITERION_STATUSES.map(status => `${status} ${review.acceptanceCriteria.filter(criterion => criterion.status === status).length}`).join(", ");
}

function report(repo: string, id: string): void {
  const run = loadRun(repo, id);
  const worktree = run.worktree && existsSync(run.worktree) ? run.worktree : null;
  const status = worktree ? git(worktree, ["status", "--short"]) : "(no worktree yet)";
  const changed = worktree ? git(worktree, ["diff", "--stat", run.baseCommit]) : "";
  const verification = verificationReport(run, repo);
  const reportText = `# Code Agent Workflow Evidence Report\n\n` +
    `- Run: ${run.id}\n- Stage: ${run.stage}\n- Spec source: ${run.specSource}\n- Spec SHA256: ${run.specHash}\n` +
    `- Base commit: ${run.baseCommit}\n- Provider: ${run.provider}\n` +
    `- Plan format: ${run.planFormat ?? "markdown (legacy)"}\n- Human approval recorded: ${run.approvedAt || "NO"}\n- Approved configuration SHA256: ${run.approvedConfigHash || "not approved"}\n- Approved plan SHA256: ${run.approvedPlanHash || "not approved"}\n- Approved plan.json SHA256: ${run.planFormat === "structured" ? (run.approvedPlanJsonHash || "not approved") : "not used"}\n- Verified worktree SHA256: ${run.verifiedWorktreeHash || "not verified"}\n- Branch: ${run.branch}\n- Worktree: ${run.worktree || "not created"}\n\n` +
    `## Reference repositories\n` + (run.references?.length ? run.references.map(reference => `- ${reference.path} @ ${reference.commit}${reference.dirty ? " (dirty at planning)" : ""}`).join("\n") : "- None") +
    `\n\n## Reference files\n` + (run.referenceFiles?.length ? run.referenceFiles.map(file => `- \`${file.path}\` \`${file.sha256}\``).join("\n") : "- None") + "\n\n" +
    `## Verification\n\nVerification passed: ${verification.passed ? "yes" : "no"}\n\n${verification.detail}\n\n` +
    `${reviewSection(run, verification.problems)}\n\n## Change status\n\n\`\`\`\n${status || "(clean)"}\n\`\`\`\n\n## Diff summary (tracked files)\n\n\`\`\`\n${changed || "(none)"}\n\`\`\`\n\n` +
    `## Events\n` + run.eventLog.map(e => `- ${e.at}: ${e.event}${e.note ? ` — ${e.note}` : ""}`).join("\n") +
    `\n\n## Artifacts\n\n- spec.md, plan.json (structured runs), plan.md, execution-agent.log, review.json and review.md (structured reviews), review.md (legacy reviews), verify-*.log\n` +
    `\n**Advisory only:** Verification passed and a reviewer verdict are different evidence. A passing check and an LLM reviewer do not replace human review, security inspection, and normal CI. Comparing recorded files does not provide tamper-proof storage. No merge, push, deployment, or PR was performed by this tool.\n`;
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
