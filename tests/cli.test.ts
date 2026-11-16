import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, realpathSync, readdirSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { hashText, newId } from "../src/paths.js";
import { commandFor } from "../src/providers.js";
import { renderPlan } from "../src/plan.js";
import { REVIEW_DIFF_PROMPT_LIMIT } from "../src/review.js";
import { validPlan } from "./plan-fixture.js";
const testsDir = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(testsDir, "../src/cli.js");

function run(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(bin, args, {cwd, encoding: "utf8", env: {...process.env, ...env}, timeout: 30000});
}
function git(cwd: string, ...args: string[]) {
  const result = run("git", args, cwd);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function caw(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}) { return run(process.execPath, [cli, ...args], cwd, env); }
function passReview(): unknown {
  return {
    schemaVersion: 1,
    verdict: "PASS",
    summary: "output.txt is present.",
    findings: [],
    acceptanceCriteria: [{id: "output-exists", status: "met", evidence: "The worktree contains output.txt."}],
    unverifiedChecks: [],
    followUps: [],
  };
}
function legacyReview(): unknown {
  return {
    schemaVersion: 1,
    verdict: "PASS",
    summary: "No structured acceptance criteria apply to this legacy plan.",
    findings: [],
    acceptanceCriteria: [],
    unverifiedChecks: [],
    followUps: [],
  };
}
function codexMock(plan: unknown, review: unknown = passReview()): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("mock 1.0"); process.exit(0); }
if (args.includes("--json")) { console.error("jsonl events are not the structured plan"); process.exit(2); }
const text = fs.readFileSync(0, "utf8");
if (text.includes("ROLE: Implementer")) {
  fs.writeFileSync("output.txt", "feature implemented\\n");
  console.log("Implemented the feature");
} else if (text.includes("ROLE: Independent code reviewer")) {
  if (!args.includes("--output-schema")) { console.error("missing --output-schema"); process.exit(2); }
  const output = args.indexOf("--output-last-message");
  const file = args[output + 1];
  if (!file || String(file).startsWith("--")) { console.error("missing --output-last-message"); process.exit(2); }
  const legacy = text.includes("no structured acceptance-criterion ids");
  fs.writeFileSync(file, legacy ? ${JSON.stringify(JSON.stringify(legacyReview()))} : ${JSON.stringify(JSON.stringify(review))});
  console.log("# Verdict\\nPASS\\nprovider diagnostics, not the review");
} else if (text.includes("ROLE: Repository-aware planning agent")) {
  if (!args.includes("--output-schema")) { console.error("missing --output-schema"); process.exit(2); }
  const output = args.indexOf("--output-last-message");
  const file = args[output + 1];
  if (!file || String(file).startsWith("--")) { console.error("missing --output-last-message"); process.exit(2); }
  fs.writeFileSync(file, ${JSON.stringify(JSON.stringify(plan))});
  console.log("provider diagnostics, not the plan");
} else {
  console.error("Unexpected prompt");
  process.exit(4);
}
`;
}

const readySpec = `# Ready feature

## Objective
Create output.txt when the feature is implemented.

## Scope
Add output.txt in the worktree and leave the main repository unchanged.

## Acceptance criteria
- [ ] output.txt exists after implementation.
`;

function setup() {
  const repo = mkdtempSync(path.join(os.tmpdir(), "caw-test-"));
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.com");
  writeFileSync(path.join(repo, "README.md"), "Fixture\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "initial");
  const result = caw(repo, ["init"]);
  assert.equal(result.status, 0, result.stderr);
  const configFile = path.join(repo, ".code-agent-workflow.json");
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  config.verify = [[process.execPath, "-e", `
const env = process.env;
if (env.CAW_TEST_SECRET_TOKEN || env.OPENAI_API_KEY || env.CODEX_API_KEY || env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN || env.CAW_CODEX_BIN) {
  console.error("verification received a restricted environment variable");
  process.exit(3);
}
if (!env.PATH || !(env.HOME || env.USERPROFILE) || env.CI !== "true") {
  console.error("verification is missing a required system environment variable");
  process.exit(4);
}
require("node:fs").existsSync("output.txt") || process.exit(2);
`]];
  writeFileSync(configFile, JSON.stringify(config, null, 2));
  writeFileSync(path.join(repo, "specs", "ready-feature.md"), readySpec);
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "workflow config and sample spec");
  const fake = path.join(repo, ".code-agent-workflow", "mock-agent.cjs");
  mkdirSync(path.dirname(fake), {recursive: true});
  writeFileSync(fake, codexMock(validPlan()));
  // executable flag for spawn on Unix; Windows callers can invoke node-compatible scripts via shims.
  chmodSync(fake, 0o755);
  return {repo, fake};
}

test("run IDs are safe for paths and content hashes are stable", () => {
  assert.match(newId(), /^run-[0-9TZ-]+-[a-f0-9]{8}$/);
  assert.equal(hashText("abc").length, 64);
});

test("model permissions are least privilege across modes", () => {
  const plan = commandFor("codex", "plan", "x", ["/tmp/reference"]).args.join(" ");
  const execute = commandFor("codex", "execute", "x", ["/tmp/reference"]).args.join(" ");
  const review = commandFor("claude", "review", "x").args.join(" ");
  const claudePlan = commandFor("claude", "plan", "x", ["/tmp/reference"]).args.join(" ");
  assert.match(plan, /--sandbox read-only/);
  assert.match(plan, /--add-dir \/tmp\/reference/);
  assert.match(execute, /--sandbox workspace-write/);
  assert.doesNotMatch(execute, /--add-dir/);
  assert.match(review, /Read,Glob,Grep/);
  assert.doesNotMatch(review, /MultiEdit/);
  assert.match(claudePlan, /--add-dir \/tmp\/reference/);
});

test("end-to-end gated workflow with test agent and a separate Git worktree", async () => {
  const {repo, fake} = setup();
  const env = {CAW_CODEX_BIN: fake};
  let result = caw(repo, ["plan", "specs/ready-feature.md"], env);
  assert.equal(result.status, 0, result.stderr);
  const runId = result.stdout.match(/Run ID: (run-[0-9TZ-]+-[a-f0-9]{8})/)?.[1];
  assert.ok(runId, result.stdout);
  const plannedDir = path.join(repo, ".code-agent-workflow", "runs", runId);
  const structuredPlan = JSON.parse(readFileSync(path.join(plannedDir, "plan.json"), "utf8"));
  assert.equal(structuredPlan.schemaVersion, 1);
  assert.match(readFileSync(path.join(plannedDir, "plan.md"), "utf8"), /# Goal/);
  const projectConfig = JSON.parse(readFileSync(path.join(repo, ".code-agent-workflow.json"), "utf8"));
  assert.equal(projectConfig.verify[0][0], process.execPath);
  result = caw(repo, ["run", runId], env);
  assert.notEqual(result.status, 0, "execution must be blocked until human approval");
  assert.match(result.stderr, /expected: approved/);
  result = caw(repo, ["approve", runId], env);
  assert.equal(result.status, 0, result.stderr);
  result = caw(repo, ["run", runId], env);
  assert.equal(result.status, 0, result.stderr);
  const base = path.join(repo, ".code-agent-workflow", "runs", runId);
  const metadata = JSON.parse(readFileSync(path.join(base, "run.json"), "utf8"));
  assert.ok(existsSync(path.join(metadata.worktree, "output.txt")));
  assert.equal(existsSync(path.join(repo, "output.txt")), false, "main repo must remain untouched");
  assert.equal(git(metadata.worktree, "rev-parse", "HEAD"), metadata.baseCommit, "must not auto-commit");
  result = caw(repo, ["verify", runId], {
    ...env,
    CAW_TEST_SECRET_TOKEN: "verification-secret",
    OPENAI_API_KEY: "codex-secret",
    CODEX_API_KEY: "codex-api-secret",
    ANTHROPIC_API_KEY: "claude-secret",
    CLAUDE_CODE_OAUTH_TOKEN: "claude-oauth-secret",
  });
  assert.equal(result.status, 0, result.stderr);
  result = caw(repo, ["review", runId], env);
  assert.equal(result.status, 0, result.stderr);
  result = caw(repo, ["report", runId], env);
  assert.equal(result.status, 0, result.stderr);
  const report = readFileSync(path.join(base, "REPORT.md"), "utf8");
  const reviewJson = JSON.parse(readFileSync(path.join(base, "review.json"), "utf8"));
  const reviewMarkdown = readFileSync(path.join(base, "review.md"), "utf8");
  assert.equal(reviewJson.verdict, "PASS");
  assert.match(reviewMarkdown, /^# Verdict\n\nPASS\n/);
  assert.doesNotMatch(reviewMarkdown, /provider diagnostics/);
  assert.match(report, /Human approval recorded/);
  assert.match(report, /Verification passed: yes/);
  assert.match(report, /Reviewer verdict: PASS/);
  assert.match(report, /does not approve a merge/);
  assert.match(report, /output.txt/);
  const final = JSON.parse(readFileSync(path.join(base, "run.json"), "utf8"));
  assert.equal(final.stage, "reviewed");
  assert.equal(final.planFormat, "structured");
  assert.equal(final.reviewFormat, "structured");
  assert.equal(final.approvedPlanJsonHash?.length, 64);
  assert.ok(final.eventLog.some((event: {event: string}) => event.event === "human_approved"));
});

test("tampering with an approved plan blocks execution before creating a worktree", () => {
  const {repo, fake} = setup();
  const env = {CAW_CODEX_BIN: fake};
  const result = caw(repo, ["plan", "specs/ready-feature.md"], env);
  assert.equal(result.status, 0, result.stderr);
  const id = result.stdout.match(/Run ID: (run-[0-9TZ-]+-[a-f0-9]{8})/)?.[1]!;
  assert.equal(caw(repo, ["approve", id], env).status, 0);
  const planFile = path.join(repo, ".code-agent-workflow", "runs", id, "plan.md");
  writeFileSync(planFile, readFileSync(planFile, "utf8") + "\nUnapproved change\n");
  const execution = caw(repo, ["run", id], env);
  assert.notEqual(execution.status, 0);
  assert.match(execution.stderr, /Approved plan changed/);
  const runState = JSON.parse(readFileSync(path.join(repo, ".code-agent-workflow", "runs", id, "run.json"), "utf8"));
  assert.equal(runState.worktree, undefined);
});

test("review receives orchestrator verification evidence and rejects an inconsistent record", () => {
  const {repo, fake} = setup();
  const env = {CAW_CODEX_BIN: fake};
  const invoked = path.join(repo, ".code-agent-workflow", "review-invoked");
  const capture = path.join(repo, ".code-agent-workflow", "review-prompt.txt");
  const installSpy = () => {
    writeFileSync(fake, `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(invoked)}, "invoked\\n");
process.exit(9);
`);
    chmodSync(fake, 0o755);
  };
  const ready = verifyReadyRun(repo, env);
  const runPath = path.join(ready.dir, "run.json");
  const withoutEvidence = JSON.parse(readFileSync(runPath, "utf8"));
  delete withoutEvidence.checkResults;
  writeFileSync(runPath, JSON.stringify(withoutEvidence, null, 2) + "\n");
  installSpy();
  const missing = caw(repo, ["review", ready.id], env);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /Verification evidence is missing/);
  assert.match(missing.stderr, /will not describe it as passing/);
  assert.equal(existsSync(invoked), false);
  assert.equal(existsSync(path.join(ready.dir, "review.json")), false);
  assert.equal(JSON.parse(readFileSync(runPath, "utf8")).stage, "verified");
  assert.equal(caw(repo, ["verify", ready.id], env).status, 0);

  const verified = JSON.parse(readFileSync(runPath, "utf8"));
  const command = verified.checkResults[0].command as string[];
  const durationMs = verified.checkResults[0].durationMs as number;
  const logged = readFileSync(path.join(ready.dir, "verify-1.log"), "utf8");
  assert.match(logged, /--- STDOUT ---/);
  const review = passReview() as {acceptanceCriteria: {evidence: string}[]};
  review.acceptanceCriteria[0]!.evidence = "CAW orchestrator verify-1.log exited 0.";
  writeFileSync(fake, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("mock 1.0"); process.exit(0); }
const text = fs.readFileSync(0, "utf8");
if (!text.includes("ROLE: Independent code reviewer")) process.exit(4);
fs.writeFileSync(${JSON.stringify(capture)}, text);
const output = args.indexOf("--output-last-message");
fs.writeFileSync(args[output + 1], ${JSON.stringify(JSON.stringify(review))});
console.log("not the review");
`);
  chmodSync(fake, 0o755);
  const reviewed = caw(repo, ["review", ready.id], env);
  assert.equal(reviewed.status, 0, reviewed.stderr);
  const prompted = readFileSync(capture, "utf8");
  assert.match(prompted, /<verification-evidence>/);
  assert.match(prompted, /The CAW orchestrator ran these approved commands\. You did not run them/);
  assert.match(prompted, /Overall verification status: passed/);
  assert.match(prompted, /does not decide code correctness, security, accessibility, or the verdict/);
  assert.match(prompted, new RegExp(`exit: 0; durationMs: ${durationMs}; log: verify-1\\.log`));
  for (const arg of command) assert.equal(prompted.includes(JSON.stringify(arg)), true);
  assert.doesNotMatch(prompted, /--- STDOUT ---/);
  const deliveredJson = readFileSync(path.join(ready.dir, "review.json"), "utf8");
  const deliveredMarkdown = readFileSync(path.join(ready.dir, "review.md"), "utf8");
  const delivered = JSON.parse(readFileSync(runPath, "utf8"));
  const saved = JSON.parse(deliveredJson);
  assert.equal(saved.acceptanceCriteria[0].status, "met");
  assert.match(saved.acceptanceCriteria[0].evidence, /CAW orchestrator verify-1\.log exited 0/);

  const mismatched = JSON.parse(readFileSync(runPath, "utf8"));
  mismatched.checkResults[0].exitCode = 1;
  writeFileSync(runPath, JSON.stringify(mismatched, null, 2) + "\n");
  installSpy();
  const rejected = caw(repo, ["review", ready.id], env);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /does not show that every approved command passed/);
  assert.match(rejected.stderr, /will not describe it as passing/);
  assert.equal(existsSync(invoked), false);
  assert.equal(readFileSync(path.join(ready.dir, "review.json"), "utf8"), deliveredJson);
  assert.equal(readFileSync(path.join(ready.dir, "review.md"), "utf8"), deliveredMarkdown);
  const preserved = JSON.parse(readFileSync(runPath, "utf8"));
  assert.equal(preserved.stage, "reviewed");
  assert.equal(preserved.reviewedAt, delivered.reviewedAt);
  assert.equal(preserved.reviewJsonHash, delivered.reviewJsonHash);
  assert.equal(preserved.reviewMarkdownHash, delivered.reviewMarkdownHash);
  assert.equal(caw(repo, ["report", ready.id], env).status, 0);
  const report = readFileSync(path.join(ready.dir, "REPORT.md"), "utf8");
  assert.match(report, /Verification passed: no/);
  assert.match(report, /does not show that every approved command passed/);
  assert.match(report, /Historical reviewer decision: PASS/);
  assert.match(report, /not a currently verified result/);
  assert.doesNotMatch(report, /Reviewer verdict: PASS/);
  assert.doesNotMatch(report, /Overall verification status: passed/);

  preserved.checkResults[0].exitCode = 0;
  preserved.checkResults[0].command = ["npm", "test"];
  writeFileSync(runPath, JSON.stringify(preserved, null, 2) + "\n");
  const wrongCommand = caw(repo, ["review", ready.id], env);
  assert.notEqual(wrongCommand.status, 0);
  assert.match(wrongCommand.stderr, /does not match the approved commands/);
  assert.equal(readFileSync(path.join(ready.dir, "review.json"), "utf8"), deliveredJson);
  assert.equal(JSON.parse(readFileSync(runPath, "utf8")).stage, "reviewed");
});

test("review rejects source changed after passing verification", () => {
  const {repo, fake} = setup();
  const env = {CAW_CODEX_BIN: fake};
  const planResult = caw(repo, ["plan", "specs/ready-feature.md"], env);
  const id = planResult.stdout.match(/Run ID: (run-[0-9TZ-]+-[a-f0-9]{8})/)?.[1]!;
  assert.equal(caw(repo, ["approve", id], env).status, 0);
  assert.equal(caw(repo, ["run", id], env).status, 0);
  assert.equal(caw(repo, ["verify", id], env).status, 0);
  const runState = JSON.parse(readFileSync(path.join(repo, ".code-agent-workflow", "runs", id, "run.json"), "utf8"));
  writeFileSync(path.join(runState.worktree, "output.txt"), "tampered after verification");
  const review = caw(repo, ["review", id], env);
  assert.notEqual(review.status, 0);
  assert.match(review.stderr, /Code changed after verification/);
});

test("plan rejects an incomplete specification before invoking an agent", () => {
  const {repo, fake} = setup();
  const marker = path.join(repo, "agent-invoked.txt");
  writeFileSync(fake, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'invoked\\n');\nconsole.log('# Goal\\nok');\n`);
  chmodSync(fake, 0o755);
  writeFileSync(path.join(repo, "specs", "incomplete.md"), `## Objective\n\n## Scope\nTBD\n\n## Acceptance criteria\n- [ ] Define observable user-facing behavior.\n`);
  git(repo, "add", "specs/incomplete.md");
  git(repo, "commit", "-qm", "incomplete spec");
  const result = caw(repo, ["plan", "specs/incomplete.md"], {CAW_CODEX_BIN: fake});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Specification is not ready to plan/);
  assert.match(result.stderr, /Objective: section is empty/);
  assert.match(result.stderr, /placeholder content "TBD"/);
  assert.match(result.stderr, /Define observable user-facing behavior/);
  assert.equal(existsSync(path.join(repo, ".code-agent-workflow", "runs")), false);
  assert.equal(existsSync(marker), false);
});

function pair(mock: string, options: {citedFile?: string; mutateReference?: boolean} = {}) {
  const parent = mkdtempSync(path.join(os.tmpdir(), "caw-port-"));
  const repo = path.join(parent, "repo-a");
  const reference = path.join(parent, "repo-b");
  mkdirSync(repo);
  mkdirSync(reference);
  for (const directory of [repo, reference]) {
    git(directory, "init", "-q");
    git(directory, "config", "user.name", "Test");
    git(directory, "config", "user.email", "test@example.com");
  }
  writeFileSync(path.join(repo, "README.md"), "Target\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "initial");
  writeFileSync(path.join(reference, "quest.ts"), "export const quest = \"quest behavior\";\n");
  git(reference, "add", ".");
  git(reference, "commit", "-qm", "quest prototype");
  assert.equal(caw(repo, ["init"]).status, 0);
  const config = JSON.parse(readFileSync(path.join(repo, ".code-agent-workflow.json"), "utf8"));
  config.verify = [[process.execPath, "-e", "require('node:fs').existsSync('output.txt') || process.exit(2)"]];
  writeFileSync(path.join(repo, ".code-agent-workflow.json"), JSON.stringify(config, null, 2));
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "workflow config");
  const fake = path.join(repo, ".code-agent-workflow", "mock-agent.cjs");
  mkdirSync(path.dirname(fake), {recursive: true});
  const plan = validPlan();
  plan.goal = "Port quest";
  plan.referenceFiles = [{repository: realpathSync(reference), path: options.citedFile ?? "quest.ts"}];
  writeFileSync(fake, mock
    .replace("__ARGV_FILE__", JSON.stringify(path.join(parent, "argv.log")))
    .replace("__STDIN_FILE__", JSON.stringify(path.join(parent, "stdin.log")))
    .replace("__MUTATE_REFERENCE__", options.mutateReference ? JSON.stringify(path.join(reference, "quest.ts")) : "undefined")
    .replace("__PLAN_TEXT__", JSON.stringify(JSON.stringify(plan)))
    .replace("__REVIEW_TEXT__", JSON.stringify(JSON.stringify(passReview())))
    .replace("__LEGACY_REVIEW_TEXT__", JSON.stringify(JSON.stringify(legacyReview()))));
  chmodSync(fake, 0o755);
  return {parent, repo, reference, fake};
}

const portMock = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("mock 1.0"); process.exit(0); }
if (args.includes("--json")) { console.error("jsonl events are not the structured plan"); process.exit(2); }
fs.appendFileSync(__ARGV_FILE__, process.argv.join(" ") + "\\n");
const text = fs.readFileSync(0, "utf8");
fs.appendFileSync(__STDIN_FILE__, text + "\\n---\\n");
if (text.includes("ROLE: Implementer")) {
  fs.writeFileSync("output.txt", "feature implemented\\n");
  console.log("Implemented the feature");
} else if (text.includes("ROLE: Independent code reviewer")) {
  if (!args.includes("--output-schema")) { console.error("missing --output-schema"); process.exit(2); }
  const output = args.indexOf("--output-last-message");
  const file = args[output + 1];
  if (!file || String(file).startsWith("--")) { console.error("missing --output-last-message"); process.exit(2); }
  const legacy = text.includes("no structured acceptance-criterion ids");
  fs.writeFileSync(file, legacy ? __LEGACY_REVIEW_TEXT__ : __REVIEW_TEXT__);
  console.log("# Verdict\\nPASS\\nprovider diagnostics, not the review");
} else if (text.includes("ROLE: Repository-aware planning agent")) {
  if (!args.includes("--output-schema")) { console.error("missing --output-schema"); process.exit(2); }
  const output = args.indexOf("--output-last-message");
  const file = args[output + 1];
  if (!file || String(file).startsWith("--")) { console.error("missing --output-last-message"); process.exit(2); }
  const mutateReference = __MUTATE_REFERENCE__;
  if (mutateReference) fs.appendFileSync(mutateReference, "\\nmutated\\n");
  fs.writeFileSync(file, __PLAN_TEXT__);
  console.log("provider diagnostics, not the plan");
} else { console.error("Unexpected prompt"); process.exit(4); }
`;

test("prompt and reference repository produce a checked plan and read-only execution", () => {
  const {parent, repo, reference} = pair(portMock);
  const argvFile = path.join(parent, "argv.log");
  const stdinFile = path.join(parent, "stdin.log");
  const env = {CAW_CODEX_BIN: path.join(repo, ".code-agent-workflow", "mock-agent.cjs")};
  const planned = caw(repo, ["plan", "--prompt", "Port the quest feature from repo-b. Reimplement it using this repository's patterns.", "--reference", "../repo-b", "--provider", "codex"], env);
  assert.equal(planned.status, 0, planned.stderr);
  const id = planned.stdout.match(/Run ID: (run-[0-9TZ-]+-[a-f0-9]{8})/)?.[1];
  assert.ok(id);
  const runDir = path.join(repo, ".code-agent-workflow", "runs", id!);
  const spec = readFileSync(path.join(runDir, "spec.md"), "utf8");
  assert.match(spec, /Port the quest feature from repo-b/);
  const state = JSON.parse(readFileSync(path.join(runDir, "run.json"), "utf8"));
  assert.equal(state.references[0].path, realpathSync(reference));
  assert.equal(state.references[0].commit, git(reference, "rev-parse", "HEAD"));
  assert.equal(state.referenceFiles[0].path, "quest.ts");
  const plannedJson = JSON.parse(readFileSync(path.join(runDir, "plan.json"), "utf8"));
  assert.equal(plannedJson.referenceFiles[0].repository, realpathSync(reference));
  assert.equal(plannedJson.referenceFiles[0].path, "quest.ts");
  assert.match(readFileSync(path.join(runDir, "plan.md"), "utf8"), /quest\.ts/);
  const plannedArgv = readFileSync(argvFile, "utf8");
  assert.match(plannedArgv, /--sandbox read-only/);
  assert.match(plannedArgv, /--ignore-user-config/);
  assert.match(plannedArgv, /--output-schema/);
  assert.match(plannedArgv, /--output-last-message/);
  assert.doesNotMatch(plannedArgv, /(?:^|\s)--json(?:\s|$)/);
  assert.ok(plannedArgv.includes(`--add-dir ${realpathSync(reference)}`));
  assert.equal(caw(repo, ["approve", id!], env).status, 0);
  const executed = caw(repo, ["run", id!], env);
  assert.equal(executed.status, 0, executed.stderr);
  const prompts = readFileSync(stdinFile, "utf8");
  assert.match(prompts, /quest behavior/);
  const executionArgv = readFileSync(argvFile, "utf8").split("\n").at(-2) ?? "";
  assert.match(executionArgv, /workspace-write/);
  assert.doesNotMatch(executionArgv, /--add-dir/);
  assert.equal(readFileSync(path.join(reference, "quest.ts"), "utf8"), "export const quest = \"quest behavior\";\n");
});

test("a plan cannot cite a reference file that does not exist", () => {
  const {repo} = pair(portMock, {citedFile: "missing.ts"});
  const env = {CAW_CODEX_BIN: path.join(repo, ".code-agent-workflow", "mock-agent.cjs")};
  const planned = caw(repo, ["plan", "--prompt", "Port the quest feature.", "--reference", "../repo-b"], env);
  assert.notEqual(planned.status, 0);
  assert.match(planned.stderr, /Reference file does not exist: missing.ts/);
});

test("changing the reference prototype blocks approval", () => {
  const {repo, reference} = pair(portMock);
  const env = {CAW_CODEX_BIN: path.join(repo, ".code-agent-workflow", "mock-agent.cjs")};
  const planned = caw(repo, ["plan", "--prompt", "Port the quest feature.", "--reference", "../repo-b"], env);
  assert.equal(planned.status, 0, planned.stderr);
  const id = planned.stdout.match(/Run ID: (run-[0-9TZ-]+-[a-f0-9]{8})/)?.[1]!;
  writeFileSync(path.join(reference, "quest.ts"), "export const quest = \"changed\";\n");
  const approved = caw(repo, ["approve", id], env);
  assert.notEqual(approved.status, 0);
  assert.match(approved.stderr, /Reference file changed since planning: quest.ts/);
});

test("a reference write during planning rejects the run", () => {
  const {repo} = pair(portMock, {mutateReference: true});
  const env = {CAW_CODEX_BIN: path.join(repo, ".code-agent-workflow", "mock-agent.cjs")};
  const planned = caw(repo, ["plan", "--prompt", "Port the quest feature.", "--reference", "../repo-b"], env);
  assert.notEqual(planned.status, 0);
  assert.match(planned.stderr, /Reference repository changed during read-only access/);
  const runs = readdirSync(path.join(repo, ".code-agent-workflow", "runs"));
  assert.equal(runs.length, 1);
  assert.equal(existsSync(path.join(repo, ".code-agent-workflow", "runs", runs[0]!, "plan.md")), false);
});

test("prose such as a save failure is not a structured plan and cannot be approved", () => {
  const {repo, fake} = setup();
  const sentence = "I couldn't save the plan file";
  writeFileSync(fake, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("mock 1.0"); process.exit(0); }
const text = fs.readFileSync(0, "utf8");
if (!text.includes("ROLE: Repository-aware planning agent")) process.exit(4);
const output = args.indexOf("--output-last-message");
fs.writeFileSync(args[output + 1], ${JSON.stringify(`${sentence}\n`)});
console.log(${JSON.stringify(sentence)});
`);
  chmodSync(fake, 0o755);
  const env = {CAW_CODEX_BIN: fake};
  const planned = caw(repo, ["plan", "specs/ready-feature.md"], env);
  assert.notEqual(planned.status, 0);
  assert.match(planned.stderr, /not valid JSON/);
  assert.doesNotMatch(planned.stdout, /Plan ready/);
  const runs = readdirSync(path.join(repo, ".code-agent-workflow", "runs"));
  assert.equal(runs.length, 1);
  const runDir = path.join(repo, ".code-agent-workflow", "runs", runs[0]!);
  assert.equal(existsSync(path.join(runDir, "plan.json")), false);
  assert.equal(existsSync(path.join(runDir, "plan.md")), false);
  assert.match(readFileSync(path.join(runDir, "plan-last-message.json"), "utf8"), /I couldn't save the plan file/);
  const state = JSON.parse(readFileSync(path.join(runDir, "run.json"), "utf8"));
  assert.equal(state.stage, "planning_failed");
  assert.equal(state.planFormat, "structured");
  state.stage = "planned";
  writeFileSync(path.join(runDir, "run.json"), JSON.stringify(state, null, 2) + "\n");
  writeFileSync(path.join(runDir, "plan.md"), `${sentence}\n`);
  const approved = caw(repo, ["approve", runs[0]!], env);
  assert.notEqual(approved.status, 0);
  assert.match(approved.stderr, /plan\.json/);
  const executed = caw(repo, ["run", runs[0]!], env);
  assert.notEqual(executed.status, 0);
  const after = JSON.parse(readFileSync(path.join(runDir, "run.json"), "utf8"));
  assert.equal(after.worktree, undefined);
});

test("an invalid structured plan cannot be approved or executed", () => {
  const {repo, fake} = setup();
  const env = {CAW_CODEX_BIN: fake};
  const planned = caw(repo, ["plan", "specs/ready-feature.md"], env);
  assert.equal(planned.status, 0, planned.stderr);
  const id = planned.stdout.match(/Run ID: (run-[0-9TZ-]+-[a-f0-9]{8})/)?.[1]!;
  const runDir = path.join(repo, ".code-agent-workflow", "runs", id);
  writeFileSync(path.join(runDir, "plan.json"), "{\"schemaVersion\":1}\n");
  const approved = caw(repo, ["approve", id], env);
  assert.notEqual(approved.status, 0);
  assert.match(approved.stderr, /plan\.json changed since planning/);
  const executed = caw(repo, ["run", id], env);
  assert.notEqual(executed.status, 0);
  assert.match(executed.stderr, /expected: approved/);
  const state = JSON.parse(readFileSync(path.join(runDir, "run.json"), "utf8"));
  assert.equal(state.worktree, undefined);
});

test("a plan.md edit before approval is rejected", () => {
  const {repo, fake} = setup();
  const env = {CAW_CODEX_BIN: fake};
  const planned = caw(repo, ["plan", "specs/ready-feature.md"], env);
  const id = planned.stdout.match(/Run ID: (run-[0-9TZ-]+-[a-f0-9]{8})/)?.[1]!;
  const planFile = path.join(repo, ".code-agent-workflow", "runs", id, "plan.md");
  writeFileSync(planFile, readFileSync(planFile, "utf8") + "\nUnreviewed edit\n");
  const approved = caw(repo, ["approve", id], env);
  assert.notEqual(approved.status, 0);
  assert.match(approved.stderr, /plan\.md changed since planning/);
});

test("rewriting the markdown snapshot cannot replace the approved plan", () => {
  const {repo, fake} = setup();
  const env = {CAW_CODEX_BIN: fake};
  const planned = caw(repo, ["plan", "specs/ready-feature.md"], env);
  const id = planned.stdout.match(/Run ID: (run-[0-9TZ-]+-[a-f0-9]{8})/)?.[1]!;
  assert.equal(caw(repo, ["approve", id], env).status, 0);
  const runDir = path.join(repo, ".code-agent-workflow", "runs", id);
  const planFile = path.join(runDir, "plan.md");
  const markdown = `${readFileSync(planFile, "utf8")}\n# Goal\nUnapproved replacement\n`;
  writeFileSync(planFile, markdown);
  const state = JSON.parse(readFileSync(path.join(runDir, "run.json"), "utf8"));
  const replacement = hashText(markdown);
  state.planMarkdownHash = replacement;
  state.approvedPlanHash = replacement;
  writeFileSync(path.join(runDir, "run.json"), JSON.stringify(state, null, 2) + "\n");
  const executed = caw(repo, ["run", id], env);
  assert.notEqual(executed.status, 0);
  assert.match(executed.stderr, /plan\.md does not match plan\.json/);
  const after = JSON.parse(readFileSync(path.join(runDir, "run.json"), "utf8"));
  assert.equal(after.stage, "approved");
  assert.equal(after.worktree, undefined);
});

test("changing approved plan.json blocks execution before a worktree is created", () => {
  const {repo, fake} = setup();
  const env = {CAW_CODEX_BIN: fake};
  const planned = caw(repo, ["plan", "specs/ready-feature.md"], env);
  const id = planned.stdout.match(/Run ID: (run-[0-9TZ-]+-[a-f0-9]{8})/)?.[1]!;
  assert.equal(caw(repo, ["approve", id], env).status, 0);
  const planFile = path.join(repo, ".code-agent-workflow", "runs", id, "plan.json");
  const plan = JSON.parse(readFileSync(planFile, "utf8"));
  plan.goal = "Changed after approval";
  writeFileSync(planFile, JSON.stringify(plan, null, 2) + "\n");
  const executed = caw(repo, ["run", id], env);
  assert.notEqual(executed.status, 0);
  assert.match(executed.stderr, /Approved plan\.json changed/);
  const state = JSON.parse(readFileSync(path.join(repo, ".code-agent-workflow", "runs", id, "run.json"), "utf8"));
  assert.equal(state.worktree, undefined);
});

function legacyRun(repo: string, id: string, plan: string): void {
  const spec = readFileSync(path.join(repo, "specs", "ready-feature.md"), "utf8");
  const dir = path.join(repo, ".code-agent-workflow", "runs", id);
  mkdirSync(dir, {recursive: true});
  writeFileSync(path.join(dir, "spec.md"), spec);
  writeFileSync(path.join(dir, "plan.md"), plan);
  writeFileSync(path.join(dir, "run.json"), JSON.stringify({
    schemaVersion: 1,
    id,
    specSource: "specs/ready-feature.md",
    specHash: hashText(spec),
    provider: "codex",
    stage: "planned",
    repoRoot: git(repo, "rev-parse", "--show-toplevel"),
    baseCommit: git(repo, "rev-parse", "HEAD"),
    branch: `caw/${id}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    eventLog: [],
  }, null, 2) + "\n");
}

test("legacy markdown-only runs still approve and execute", () => {
  const {repo, fake} = setup();
  const env = {CAW_CODEX_BIN: fake};
  const id = "run-20260101T000000Z-abcdef01";
  legacyRun(repo, id, "# Goal\nLegacy plan\n");
  assert.equal(caw(repo, ["approve", id], env).status, 0);
  const executed = caw(repo, ["run", id], env);
  assert.equal(executed.status, 0, executed.stderr);
  const state = JSON.parse(readFileSync(path.join(repo, ".code-agent-workflow", "runs", id, "run.json"), "utf8"));
  assert.equal(state.planFormat, undefined);
  assert.equal(state.approvedPlanJsonHash, undefined);
  assert.equal(existsSync(path.join(repo, ".code-agent-workflow", "runs", id, "plan.json")), false);
  assert.equal(existsSync(path.join(state.worktree, "output.txt")), true);
});

test("a legacy approved plan.md is still protected", () => {
  const {repo, fake} = setup();
  const env = {CAW_CODEX_BIN: fake};
  const id = "run-20260101T000000Z-abcdef02";
  legacyRun(repo, id, "# Goal\nLegacy plan\n");
  assert.equal(caw(repo, ["approve", id], env).status, 0);
  const planFile = path.join(repo, ".code-agent-workflow", "runs", id, "plan.md");
  writeFileSync(planFile, readFileSync(planFile, "utf8") + "\nUnapproved change\n");
  const executed = caw(repo, ["run", id], env);
  assert.notEqual(executed.status, 0);
  assert.match(executed.stderr, /Approved plan changed/);
  const state = JSON.parse(readFileSync(path.join(repo, ".code-agent-workflow", "runs", id, "run.json"), "utf8"));
  assert.equal(state.worktree, undefined);
});

test("Claude structured output uses the envelope and ignores result prose", () => {
  const {repo, fake} = setup();
  const sentence = "I couldn't save the plan file";
  const envelope = {type: "result", subtype: "success", is_error: false, result: sentence, structured_output: validPlan()};
  writeFileSync(fake, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("mock 1.0"); process.exit(0); }
fs.readFileSync(0);
fs.writeFileSync(process.argv[1] + ".argv", process.argv.join("\\n"));
if (args[args.indexOf("--output-format") + 1] !== "json" || !args.includes("--json-schema")) process.exit(2);
console.log(${JSON.stringify(JSON.stringify(envelope))});
`);
  chmodSync(fake, 0o755);
  const planned = caw(repo, ["plan", "specs/ready-feature.md", "--provider", "claude"], {CAW_CLAUDE_BIN: fake});
  assert.equal(planned.status, 0, planned.stderr);
  const id = planned.stdout.match(/Run ID: (run-[0-9TZ-]+-[a-f0-9]{8})/)?.[1]!;
  const runDir = path.join(repo, ".code-agent-workflow", "runs", id);
  const plan = JSON.parse(readFileSync(path.join(runDir, "plan.json"), "utf8"));
  assert.equal(plan.goal, validPlan().goal);
  assert.doesNotMatch(readFileSync(path.join(runDir, "plan.md"), "utf8"), /I couldn't save the plan file/);
  const argv = readFileSync(`${fake}.argv`, "utf8").split("\n");
  assert.equal(argv.includes("--strict-mcp-config"), true);
  assert.equal(argv.includes("--mcp-config"), false);
  assert.equal(argv[argv.indexOf("--disallowedTools") + 1], "mcp__*");
  assert.equal(argv[argv.indexOf("--output-format") + 1], "json");
  assert.equal(argv.includes("--json-schema"), true);
  assert.equal(argv[argv.indexOf("--tools") + 1], "Read,Glob,Grep");
});

test("Claude prose without structured_output is not a plan", () => {
  const {repo, fake} = setup();
  const sentence = "I couldn't save the plan file";
  writeFileSync(fake, `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--version")) { console.log("mock 1.0"); process.exit(0); }
fs.readFileSync(0);
console.log(${JSON.stringify(sentence)});
`);
  chmodSync(fake, 0o755);
  const planned = caw(repo, ["plan", "specs/ready-feature.md", "--provider", "claude"], {CAW_CLAUDE_BIN: fake});
  assert.notEqual(planned.status, 0);
  assert.match(planned.stderr, /not a JSON envelope/);
  const runs = readdirSync(path.join(repo, ".code-agent-workflow", "runs"));
  const runDir = path.join(repo, ".code-agent-workflow", "runs", runs[0]!);
  assert.match(readFileSync(path.join(runDir, "plan-agent.log"), "utf8"), /I couldn't save the plan file/);
  assert.equal(existsSync(path.join(runDir, "plan.json")), false);
});

test("structured planning cites files from more than one reference repository", () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), "caw-multi-"));
  const repo = path.join(parent, "repo-a");
  const first = path.join(parent, "repo-b");
  const second = path.join(parent, "repo-c");
  for (const directory of [repo, first, second]) {
    mkdirSync(directory);
    git(directory, "init", "-q");
    git(directory, "config", "user.name", "Test");
    git(directory, "config", "user.email", "test@example.com");
  }
  writeFileSync(path.join(repo, "README.md"), "Target\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "initial");
  writeFileSync(path.join(first, "quest.ts"), "export const quest = 1;\n");
  git(first, "add", ".");
  git(first, "commit", "-qm", "first");
  writeFileSync(path.join(second, "notes.md"), "notes\n");
  git(second, "add", ".");
  git(second, "commit", "-qm", "second");
  assert.equal(caw(repo, ["init"]).status, 0);
  const config = JSON.parse(readFileSync(path.join(repo, ".code-agent-workflow.json"), "utf8"));
  config.verify = [[process.execPath, "-e", "process.exit(0)"]];
  writeFileSync(path.join(repo, ".code-agent-workflow.json"), JSON.stringify(config, null, 2));
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "workflow config");
  const plan = validPlan();
  plan.referenceFiles = [
    {repository: realpathSync(first), path: "quest.ts"},
    {repository: realpathSync(second), path: "notes.md"},
  ];
  const fake = path.join(repo, ".code-agent-workflow", "mock-agent.cjs");
  mkdirSync(path.dirname(fake), {recursive: true});
  writeFileSync(fake, codexMock(plan));
  chmodSync(fake, 0o755);
  const planned = caw(repo, ["plan", "--prompt", "Port both prototypes.", "--reference", "../repo-b", "--reference", "../repo-c"], {CAW_CODEX_BIN: fake});
  assert.equal(planned.status, 0, planned.stderr);
  const id = planned.stdout.match(/Run ID: (run-[0-9TZ-]+-[a-f0-9]{8})/)?.[1]!;
  const state = JSON.parse(readFileSync(path.join(repo, ".code-agent-workflow", "runs", id, "run.json"), "utf8"));
  assert.equal(state.referenceFiles.length, 2);
  assert.equal(state.referenceFiles[0].path, "quest.ts");
  assert.equal(state.referenceFiles[1].path, "notes.md");
  assert.equal(state.referenceFiles[0].repository, realpathSync(first));
  assert.equal(state.referenceFiles[1].repository, realpathSync(second));
  assert.notEqual(state.referenceFiles[0].sha256, state.referenceFiles[1].sha256);
});

function addNotes(reference: string): string {
  const notes = "notes\n";
  writeFileSync(path.join(reference, "notes.md"), notes);
  git(reference, "add", ".");
  git(reference, "commit", "-qm", "notes");
  return notes;
}

function retargetReference(repo: string, id: string, reference: string, citedPath: string): void {
  const runDir = path.join(repo, ".code-agent-workflow", "runs", id);
  const plan = JSON.parse(readFileSync(path.join(runDir, "plan.json"), "utf8"));
  plan.referenceFiles = [{repository: realpathSync(reference), path: citedPath}];
  writeFileSync(path.join(runDir, "plan.json"), JSON.stringify(plan, null, 2) + "\n");
  writeFileSync(path.join(runDir, "plan.md"), renderPlan(plan));
}

test("editing reference-file entries before approval is rejected", () => {
  const {repo, reference} = pair(portMock);
  addNotes(reference);
  const env = {CAW_CODEX_BIN: path.join(repo, ".code-agent-workflow", "mock-agent.cjs")};
  const planned = caw(repo, ["plan", "--prompt", "Port the quest feature.", "--reference", "../repo-b"], env);
  assert.equal(planned.status, 0, planned.stderr);
  const id = planned.stdout.match(/Run ID: (run-[0-9TZ-]+-[a-f0-9]{8})/)?.[1]!;
  const runFile = path.join(repo, ".code-agent-workflow", "runs", id, "run.json");
  const before = JSON.parse(readFileSync(runFile, "utf8"));
  retargetReference(repo, id, reference, "notes.md");
  const approved = caw(repo, ["approve", id], env);
  assert.notEqual(approved.status, 0);
  assert.match(approved.stderr, /plan\.json changed since planning/);
  const after = JSON.parse(readFileSync(runFile, "utf8"));
  assert.equal(after.stage, "planned");
  assert.equal(after.approvedAt, undefined);
  assert.equal(after.referenceFiles[0].path, "quest.ts");
  assert.equal(after.referenceFiles[0].sha256, before.referenceFiles[0].sha256);
  assert.equal(after.worktree, undefined);
  const executed = caw(repo, ["run", id], env);
  assert.notEqual(executed.status, 0);
  assert.equal(JSON.parse(readFileSync(runFile, "utf8")).worktree, undefined);
});

test("a changed reference list cannot reuse captured evidence", () => {
  const {repo, reference} = pair(portMock);
  addNotes(reference);
  const env = {CAW_CODEX_BIN: path.join(repo, ".code-agent-workflow", "mock-agent.cjs")};
  const planned = caw(repo, ["plan", "--prompt", "Port the quest feature.", "--reference", "../repo-b"], env);
  assert.equal(planned.status, 0, planned.stderr);
  const id = planned.stdout.match(/Run ID: (run-[0-9TZ-]+-[a-f0-9]{8})/)?.[1]!;
  const runDir = path.join(repo, ".code-agent-workflow", "runs", id);
  retargetReference(repo, id, reference, "notes.md");
  const state = JSON.parse(readFileSync(path.join(runDir, "run.json"), "utf8"));
  state.planJsonHash = hashText(readFileSync(path.join(runDir, "plan.json"), "utf8"));
  state.planMarkdownHash = hashText(readFileSync(path.join(runDir, "plan.md"), "utf8"));
  writeFileSync(path.join(runDir, "run.json"), JSON.stringify(state, null, 2) + "\n");
  const approved = caw(repo, ["approve", id], env);
  assert.notEqual(approved.status, 0);
  assert.match(approved.stderr, /do not match the evidence captured during planning/);
  const after = JSON.parse(readFileSync(path.join(runDir, "run.json"), "utf8"));
  assert.equal(after.stage, "planned");
  assert.equal(after.referenceFiles[0].path, "quest.ts");
  assert.equal(after.referenceFiles[0].sha256, state.referenceFiles[0].sha256);
  assert.equal(after.worktree, undefined);
});

test("execution rejects reference evidence that diverges from the approved plan", () => {
  const {repo, reference} = pair(portMock);
  const notes = addNotes(reference);
  const env = {CAW_CODEX_BIN: path.join(repo, ".code-agent-workflow", "mock-agent.cjs")};
  const planned = caw(repo, ["plan", "--prompt", "Port the quest feature.", "--reference", "../repo-b"], env);
  assert.equal(planned.status, 0, planned.stderr);
  const id = planned.stdout.match(/Run ID: (run-[0-9TZ-]+-[a-f0-9]{8})/)?.[1]!;
  assert.equal(caw(repo, ["approve", id], env).status, 0);
  const runFile = path.join(repo, ".code-agent-workflow", "runs", id, "run.json");
  const state = JSON.parse(readFileSync(runFile, "utf8"));
  state.referenceFiles = [{
    repository: realpathSync(reference),
    path: "notes.md",
    sha256: createHash("sha256").update(notes).digest("hex"),
  }];
  writeFileSync(runFile, JSON.stringify(state, null, 2) + "\n");
  const executed = caw(repo, ["run", id], env);
  assert.notEqual(executed.status, 0);
  assert.match(executed.stderr, /do not match the evidence captured during planning/);
  const after = JSON.parse(readFileSync(runFile, "utf8"));
  assert.equal(after.stage, "approved");
  assert.equal(after.worktree, undefined);
});

test("review rejects reference evidence that diverges from the approved plan", () => {
  const {repo, reference} = pair(portMock);
  const notes = addNotes(reference);
  const env = {CAW_CODEX_BIN: path.join(repo, ".code-agent-workflow", "mock-agent.cjs")};
  const planned = caw(repo, ["plan", "--prompt", "Port the quest feature.", "--reference", "../repo-b"], env);
  assert.equal(planned.status, 0, planned.stderr);
  const id = planned.stdout.match(/Run ID: (run-[0-9TZ-]+-[a-f0-9]{8})/)?.[1]!;
  assert.equal(caw(repo, ["approve", id], env).status, 0);
  assert.equal(caw(repo, ["run", id], env).status, 0);
  assert.equal(caw(repo, ["verify", id], env).status, 0);
  const runDir = path.join(repo, ".code-agent-workflow", "runs", id);
  const runFile = path.join(runDir, "run.json");
  const state = JSON.parse(readFileSync(runFile, "utf8"));
  state.referenceFiles = [{
    repository: realpathSync(reference),
    path: "notes.md",
    sha256: createHash("sha256").update(notes).digest("hex"),
  }];
  writeFileSync(runFile, JSON.stringify(state, null, 2) + "\n");
  const reviewed = caw(repo, ["review", id], env);
  assert.notEqual(reviewed.status, 0);
  assert.match(reviewed.stderr, /do not match the evidence captured during planning/);
  const after = JSON.parse(readFileSync(runFile, "utf8"));
  assert.equal(after.stage, "verified");
  assert.equal(existsSync(path.join(runDir, "review.md")), false);
  assert.equal(existsSync(path.join(runDir, "review.json")), false);
});

function verifyReadyRun(repo: string, env: NodeJS.ProcessEnv): {id: string; dir: string} {
  const planned = caw(repo, ["plan", "specs/ready-feature.md"], env);
  assert.equal(planned.status, 0, planned.stderr);
  const id = planned.stdout.match(/Run ID: (run-[0-9TZ-]+-[a-f0-9]{8})/)?.[1];
  assert.ok(id);
  assert.equal(caw(repo, ["approve", id], env).status, 0);
  const executed = caw(repo, ["run", id], env);
  assert.equal(executed.status, 0, executed.stderr);
  const verified = caw(repo, ["verify", id], env);
  assert.equal(verified.status, 0, verified.stderr);
  return {id, dir: path.join(repo, ".code-agent-workflow", "runs", id)};
}

test("needs-changes and insufficient-evidence reviews are delivered without approval", () => {
  const {repo, fake} = setup();
  const env = {CAW_CODEX_BIN: fake};
  const needsChanges = {
    schemaVersion: 1,
    verdict: "NEEDS_CHANGES",
    summary: "The focus trap is untested.",
    findings: [{
      id: "missing-focus-test",
      severity: "high",
      path: "src/dialog.test.ts",
      startLine: 12,
      endLine: 14,
      explanation: "The diff does not cover keyboard focus.",
      suggestedFix: "Add a focus test.",
      acceptanceCriteria: ["output-exists"],
    }],
    acceptanceCriteria: [{id: "output-exists", status: "met", evidence: "output.txt exists."}],
    unverifiedChecks: ["The reviewer did not run the test suite."],
    followUps: ["Retry the dialog with a keyboard."],
  };
  writeFileSync(fake, codexMock(validPlan(), needsChanges));
  chmodSync(fake, 0o755);
  const first = verifyReadyRun(repo, env);
  const reviewed = caw(repo, ["review", first.id], env);
  assert.equal(reviewed.status, 0, reviewed.stderr);
  assert.match(reviewed.stdout, /Verdict: NEEDS_CHANGES/);
  const state = JSON.parse(readFileSync(path.join(first.dir, "run.json"), "utf8"));
  assert.equal(state.stage, "reviewed");
  assert.equal(JSON.parse(readFileSync(path.join(first.dir, "review.json"), "utf8")).verdict, "NEEDS_CHANGES");
  const reported = caw(repo, ["report", first.id], env);
  assert.equal(reported.status, 0, reported.stderr);
  const report = readFileSync(path.join(first.dir, "REPORT.md"), "utf8");
  assert.match(report, /Verification passed: yes/);
  assert.match(report, /Reviewer verdict: NEEDS_CHANGES/);
  assert.match(report, /critical 0, high 1, medium 0, low 0, info 0/);
  assert.match(report, /met 1, not_met 0, uncertain 0/);
  assert.match(report, /missing-focus-test/);
  assert.match(report, /src\/dialog\.test\.ts:12-14/);
  assert.match(report, /does not approve a merge/);
  assert.doesNotMatch(report, /Reviewer verdict: PASS/);
  const saved = readFileSync(path.join(first.dir, "review.json"), "utf8");
  writeFileSync(path.join(first.dir, "review.json"), saved.replace("NEEDS_CHANGES", "PASS"));
  const tampered = caw(repo, ["report", first.id], env);
  assert.equal(tampered.status, 0, tampered.stderr);
  const afterTamper = readFileSync(path.join(first.dir, "REPORT.md"), "utf8");
  assert.match(afterTamper, /Reviewer verdict: not recorded/);
  assert.match(afterTamper, /changed after delivery/);
  assert.doesNotMatch(afterTamper, /Reviewer verdict: PASS/);

  const insufficient = {
    schemaVersion: 1,
    verdict: "INSUFFICIENT_EVIDENCE",
    summary: "The worktree diff could not be compared with the plan.",
    findings: [],
    acceptanceCriteria: [{id: "output-exists", status: "uncertain", evidence: "output.txt was not inspected."}],
    unverifiedChecks: ["The reviewer could not read output.txt."],
    followUps: [],
  };
  writeFileSync(fake, codexMock(validPlan(), insufficient));
  chmodSync(fake, 0o755);
  const second = verifyReadyRun(repo, env);
  const evidence = caw(repo, ["review", second.id], env);
  assert.equal(evidence.status, 0, evidence.stderr);
  assert.match(evidence.stdout, /Verdict: INSUFFICIENT_EVIDENCE/);
  assert.equal(JSON.parse(readFileSync(path.join(second.dir, "run.json"), "utf8")).stage, "reviewed");
  assert.equal(caw(repo, ["report", second.id], env).status, 0);
  const evidenceReport = readFileSync(path.join(second.dir, "REPORT.md"), "utf8");
  assert.match(evidenceReport, /Reviewer verdict: INSUFFICIENT_EVIDENCE/);
  assert.match(evidenceReport, /does not approve a merge/);
  assert.doesNotMatch(evidenceReport, /Reviewer verdict: PASS/);
});

test("invalid review output is not recorded as a delivered review", () => {
  const {repo, fake} = setup();
  const env = {CAW_CODEX_BIN: fake};
  const ready = verifyReadyRun(repo, env);
  const prose = "# Verdict\nPASS\nThis approves the merge.";
  writeFileSync(fake, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("mock 1.0"); process.exit(0); }
const text = fs.readFileSync(0, "utf8");
if (!text.includes("ROLE: Independent code reviewer")) process.exit(4);
const output = args.indexOf("--output-last-message");
fs.writeFileSync(args[output + 1], ${JSON.stringify(`${prose}\n`)});
console.log(${JSON.stringify(prose)});
`);
  chmodSync(fake, 0o755);
  const reviewed = caw(repo, ["review", ready.id], env);
  assert.notEqual(reviewed.status, 0);
  assert.match(reviewed.stderr, /not valid JSON/);
  assert.equal(existsSync(path.join(ready.dir, "review.json")), false);
  assert.equal(existsSync(path.join(ready.dir, "review.md")), false);
  assert.match(readFileSync(path.join(ready.dir, "review-agent.log"), "utf8"), /This approves the merge/);
  assert.match(readFileSync(path.join(ready.dir, "review-last-message.json"), "utf8"), /# Verdict/);
  const state = JSON.parse(readFileSync(path.join(ready.dir, "run.json"), "utf8"));
  assert.equal(state.stage, "review_failed");
  assert.equal(state.reviewFormat, undefined);
  const reported = caw(repo, ["report", ready.id], env);
  assert.equal(reported.status, 0, reported.stderr);
  const report = readFileSync(path.join(ready.dir, "REPORT.md"), "utf8");
  assert.match(report, /Delivery: failed/);
  assert.match(report, /Reviewer verdict: not recorded/);
  assert.doesNotMatch(report, /This approves the merge/);
  assert.doesNotMatch(report, /Reviewer verdict: PASS/);
});

test("legacy runs remain readable and a new review does not invent criterion ids", () => {
  const {repo, fake} = setup();
  const env = {CAW_CODEX_BIN: fake};
  const id = "run-20260101T000000Z-abcdef03";
  legacyRun(repo, id, "# Goal\nLegacy plan\n");
  const dir = path.join(repo, ".code-agent-workflow", "runs", id);
  const historical = "# Verdict\nPASS\n\nThis historical review approves the merge.\n";
  const state = JSON.parse(readFileSync(path.join(dir, "run.json"), "utf8"));
  state.stage = "reviewed";
  state.approvedAt = "2026-01-01T00:00:00.000Z";
  state.approvedPlanHash = hashText(readFileSync(path.join(dir, "plan.md"), "utf8"));
  state.reviewProvider = "codex";
  state.reviewedAt = "2026-01-01T00:01:00.000Z";
  writeFileSync(path.join(dir, "run.json"), JSON.stringify(state, null, 2) + "\n");
  writeFileSync(path.join(dir, "review.md"), historical);
  const reported = caw(repo, ["report", id], env);
  assert.equal(reported.status, 0, reported.stderr);
  const report = readFileSync(path.join(dir, "REPORT.md"), "utf8");
  assert.match(report, /Human approval recorded/);
  assert.match(report, /Format: markdown \(legacy\)/);
  assert.match(report, /Reviewer verdict: not recorded/);
  assert.match(report, /does not approve a merge/);
  assert.doesNotMatch(report, /Reviewer verdict: PASS/);
  assert.doesNotMatch(report, /approves the merge/);

  const reviewable = "run-20260101T000000Z-abcdef04";
  legacyRun(repo, reviewable, "# Goal\nLegacy plan\n");
  assert.equal(caw(repo, ["approve", reviewable], env).status, 0);
  assert.equal(caw(repo, ["run", reviewable], env).status, 0);
  assert.equal(caw(repo, ["verify", reviewable], env).status, 0);
  const reviewed = caw(repo, ["review", reviewable], env);
  assert.equal(reviewed.status, 0, reviewed.stderr);
  const reviewDir = path.join(repo, ".code-agent-workflow", "runs", reviewable);
  const review = JSON.parse(readFileSync(path.join(reviewDir, "review.json"), "utf8"));
  assert.equal(review.verdict, "PASS");
  assert.deepEqual(review.acceptanceCriteria, []);
  assert.match(readFileSync(path.join(reviewDir, "review.md"), "utf8"), /None were invented/);
  const fresh = JSON.parse(readFileSync(path.join(reviewDir, "run.json"), "utf8"));
  assert.equal(fresh.planFormat, undefined);
  assert.equal(fresh.reviewFormat, "structured");
  assert.equal(fresh.stage, "reviewed");
});

test("Claude review uses structured_output and ignores result prose", () => {
  const {repo, fake} = setup();
  const sentence = "I couldn't save the review file. PASS. This approves the merge.";
  const review = passReview();
  const planEnvelope = {type: "result", subtype: "success", is_error: false, result: sentence, structured_output: validPlan()};
  const reviewEnvelope = {type: "result", subtype: "success", is_error: false, result: sentence, structured_output: review};
  writeFileSync(fake, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("mock 1.0"); process.exit(0); }
const prompt = args[args.indexOf("-p") + 1] || "";
fs.appendFileSync(${JSON.stringify(fake + ".argv")}, process.argv.join("\\n") + "\\n---\\n");
if (prompt.includes("ROLE: Implementer")) {
  fs.writeFileSync("output.txt", "feature implemented\\n");
  console.log("implemented");
} else if (prompt.includes("ROLE: Independent code reviewer")) {
  if (args[args.indexOf("--output-format") + 1] !== "json" || !args.includes("--json-schema")) process.exit(2);
  console.log(${JSON.stringify(JSON.stringify(reviewEnvelope))});
} else if (prompt.includes("ROLE: Repository-aware planning agent")) {
  if (args[args.indexOf("--output-format") + 1] !== "json" || !args.includes("--json-schema")) process.exit(2);
  console.log(${JSON.stringify(JSON.stringify(planEnvelope))});
} else process.exit(4);
`);
  chmodSync(fake, 0o755);
  const configFile = path.join(repo, ".code-agent-workflow.json");
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  config.defaultProvider = "claude";
  writeFileSync(configFile, JSON.stringify(config, null, 2));
  git(repo, "add", ".code-agent-workflow.json");
  git(repo, "commit", "-qm", "select claude");
  const env = {CAW_CLAUDE_BIN: fake};
  const ready = verifyReadyRun(repo, env);
  const reviewed = caw(repo, ["review", ready.id, "--provider", "claude"], env);
  assert.equal(reviewed.status, 0, reviewed.stderr);
  const saved = JSON.parse(readFileSync(path.join(ready.dir, "review.json"), "utf8"));
  assert.equal(saved.verdict, "PASS");
  assert.equal(saved.summary, "output.txt is present.");
  const markdown = readFileSync(path.join(ready.dir, "review.md"), "utf8");
  assert.doesNotMatch(markdown, /couldn't save the review file/);
  assert.doesNotMatch(markdown, /approves the merge/);
  const argv = readFileSync(`${fake}.argv`, "utf8");
  const reviewArgs = argv.split("\n---\n").find(entry => entry.includes("ROLE: Independent code reviewer")) ?? "";
  assert.match(reviewArgs, /--strict-mcp-config/);
  assert.doesNotMatch(reviewArgs, /--mcp-config/);
  assert.match(reviewArgs, /mcp__\*/);
  assert.match(reviewArgs, /--output-format\njson/);
  assert.match(reviewArgs, /--json-schema/);
  assert.match(reviewArgs, /Read,Glob,Grep/);
  assert.doesNotMatch(reviewArgs, /MultiEdit/);
  assert.match(reviewArgs, /dontAsk/);
});

test("a truncated tracked diff cannot pass, even when a reviewer returns its SHA-256", () => {
  const {repo, fake} = setup();
  const env = {CAW_CODEX_BIN: fake};
  const planned = caw(repo, ["plan", "specs/ready-feature.md"], env);
  assert.equal(planned.status, 0, planned.stderr);
  const id = planned.stdout.match(/Run ID: (run-[0-9TZ-]+-[a-f0-9]{8})/)?.[1];
  assert.ok(id);
  assert.equal(caw(repo, ["approve", id], env).status, 0);
  assert.equal(caw(repo, ["run", id], env).status, 0);
  const dir = path.join(repo, ".code-agent-workflow", "runs", id);
  const worktree = JSON.parse(readFileSync(path.join(dir, "run.json"), "utf8")).worktree as string;
  const omittedMarker = "UNIQUE-OMITTED-TAIL";
  writeFileSync(path.join(worktree, "README.md"), `${"x".repeat(REVIEW_DIFF_PROMPT_LIMIT)}${omittedMarker}\n`);
  assert.equal(caw(repo, ["verify", id], env).status, 0);
  const capture = path.join(repo, ".code-agent-workflow", "review-prompt.txt");
  const install = (body: string) => {
    writeFileSync(fake, body);
    chmodSync(fake, 0o755);
  };
  install(`#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("mock 1.0"); process.exit(0); }
const text = fs.readFileSync(0, "utf8");
if (!text.includes("ROLE: Independent code reviewer")) process.exit(4);
fs.writeFileSync(${JSON.stringify(capture)}, text);
const output = args.indexOf("--output-last-message");
fs.writeFileSync(args[output + 1], ${JSON.stringify(JSON.stringify(passReview()))});
console.log("I inspected the entire diff");
`);
  const rejected = caw(repo, ["review", id], env);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /PASS is not accepted because the tracked diff was truncated/);
  assert.match(rejected.stderr, /does not establish that the omitted changes were inspected/);
  assert.equal(existsSync(path.join(dir, "review.json")), false);
  assert.equal(existsSync(path.join(dir, "review.md")), false);
  const prompted = readFileSync(capture, "utf8");
  const base = JSON.parse(readFileSync(path.join(dir, "run.json"), "utf8")).baseCommit as string;
  const fullDiff = git(worktree, "diff", "--no-ext-diff", base);
  assert.ok(fullDiff.length > REVIEW_DIFF_PROMPT_LIMIT);
  const fingerprint = hashText(fullDiff);
  assert.match(prompted, /truncated="true"/);
  assert.match(prompted, /The tracked diff is incomplete/);
  assert.match(prompted, new RegExp(`git diff --no-ext-diff ${base}`));
  assert.equal(prompted.includes("<untracked-files truncated=\"false\" omitted-entries=\"0\">" + "\n" + "output.txt" + "\n" + "</untracked-files>"), true);
  assert.match(prompted, /Use file read tools to inspect any untracked source files/);
  assert.equal(prompted.includes(fingerprint), false);
  assert.equal(prompted.includes(omittedMarker), false);

  const insufficient = {
    schemaVersion: 1,
    verdict: "INSUFFICIENT_EVIDENCE",
    summary: "The embedded diff does not contain the whole change.",
    findings: [],
    acceptanceCriteria: [{id: "output-exists", status: "uncertain", evidence: "The omitted diff was not fingerprinted."}],
    unverifiedChecks: ["The tracked diff was truncated and the omitted characters were not established."],
    followUps: [],
  };
  install(`#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("mock 1.0"); process.exit(0); }
fs.readFileSync(0, "utf8");
const output = args.indexOf("--output-last-message");
fs.writeFileSync(args[output + 1], ${JSON.stringify(JSON.stringify(insufficient))});
console.log("not the review");
`);
  const delivered = caw(repo, ["review", id], env);
  assert.equal(delivered.status, 0, delivered.stderr);
  assert.match(delivered.stdout, /Verdict: INSUFFICIENT_EVIDENCE/);
  const savedEvidence = JSON.parse(readFileSync(path.join(dir, "review.json"), "utf8"));
  assert.equal(savedEvidence.verdict, "INSUFFICIENT_EVIDENCE");
  assert.equal(Object.hasOwn(savedEvidence, "inspectedDiffSha256"), false);
  const evidenceState = JSON.parse(readFileSync(path.join(dir, "run.json"), "utf8"));
  assert.equal(evidenceState.reviewDiffTruncated, true);
  assert.equal(evidenceState.reviewDiffSha256, fingerprint);
  assert.equal(caw(repo, ["report", id], env).status, 0);
  const evidenceReport = readFileSync(path.join(dir, "REPORT.md"), "utf8");
  assert.match(evidenceReport, /Reviewer verdict: INSUFFICIENT_EVIDENCE/);
  assert.match(evidenceReport, new RegExp(`Complete-diff SHA-256 ${fingerprint} is diagnostic provenance`));
  assert.match(evidenceReport, /does not establish that the omitted changes were inspected/);
  assert.doesNotMatch(evidenceReport, /Reviewer verdict: PASS/);
  assert.doesNotMatch(evidenceReport, /matched the complete-diff fingerprint/);
  assert.doesNotMatch(evidenceReport, /proves review completeness/);

  install(`#!/usr/bin/env node
const fs = require("node:fs");
const {createHash} = require("node:crypto");
const {execFileSync} = require("node:child_process");
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("mock 1.0"); process.exit(0); }
const text = fs.readFileSync(0, "utf8");
const base = /Base commit for diff: ([0-9a-f]+)/.exec(text);
if (!base) process.exit(5);
const diff = execFileSync("git", ["diff", "--no-ext-diff", base[1]], {encoding: "utf8"}).trim();
const review = ${JSON.stringify(passReview())};
review.summary = createHash("sha256").update(diff).digest("hex");
const output = args.indexOf("--output-last-message");
fs.writeFileSync(args[output + 1], JSON.stringify(review));
console.log("not the review");
`);
  const hashed = caw(repo, ["review", id], env);
  assert.notEqual(hashed.status, 0);
  assert.match(hashed.stderr, /PASS is not accepted because the tracked diff was truncated/);
  assert.match(hashed.stderr, /does not establish that the omitted changes were inspected/);
  assert.match(hashed.stderr, /previously delivered review was left unchanged/);
  const preserved = JSON.parse(readFileSync(path.join(dir, "review.json"), "utf8"));
  assert.equal(preserved.verdict, "INSUFFICIENT_EVIDENCE");
  const preservedState = JSON.parse(readFileSync(path.join(dir, "run.json"), "utf8"));
  assert.equal(preservedState.stage, "reviewed");
  assert.equal(preservedState.reviewDiffTruncated, true);
  assert.equal(preservedState.reviewDiffSha256, fingerprint);

  const needsChanges = {
    schemaVersion: 1,
    verdict: "NEEDS_CHANGES",
    summary: "The visible portion of the diff is missing a test.",
    findings: [{
      id: "missing-check",
      severity: "high",
      path: "README.md",
      startLine: null,
      endLine: null,
      explanation: "The embedded change does not show a test.",
      suggestedFix: "Add a test for the changed behavior.",
      acceptanceCriteria: ["output-exists"],
    }],
    acceptanceCriteria: [{id: "output-exists", status: "not_met", evidence: "The omitted diff was not fully embedded."}],
    unverifiedChecks: [],
    followUps: [],
  };
  install(`#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("mock 1.0"); process.exit(0); }
fs.readFileSync(0, "utf8");
const output = args.indexOf("--output-last-message");
fs.writeFileSync(args[output + 1], ${JSON.stringify(JSON.stringify(needsChanges))});
console.log("not the review");
`);
  const changed = caw(repo, ["review", id], env);
  assert.equal(changed.status, 0, changed.stderr);
  assert.match(changed.stdout, /Verdict: NEEDS_CHANGES/);
  assert.equal(caw(repo, ["report", id], env).status, 0);
  const report = readFileSync(path.join(dir, "REPORT.md"), "utf8");
  assert.match(report, /Reviewer verdict: NEEDS_CHANGES/);
  assert.match(report, /does not establish that the omitted changes were inspected/);
  assert.match(report, /does not approve a merge/);
  assert.doesNotMatch(report, /Reviewer verdict: PASS/);
  assert.doesNotMatch(report, /matched the complete-diff fingerprint/);
});

test("a failed re-review leaves the last delivered review in place", () => {
  const {repo, fake} = setup();
  const env = {CAW_CODEX_BIN: fake};
  const installFailure = () => {
    writeFileSync(fake, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("mock 1.0"); process.exit(0); }
const text = fs.readFileSync(0, "utf8");
if (!text.includes("ROLE: Independent code reviewer")) process.exit(4);
const output = args.indexOf("--output-last-message");
fs.writeFileSync(args[output + 1], "# Verdict\\nPASS\\nnot a review\\n");
console.log("retry failed");
`);
    chmodSync(fake, 0o755);
  };
  const ready = verifyReadyRun(repo, env);
  assert.equal(caw(repo, ["review", ready.id], env).status, 0);
  const jsonPath = path.join(ready.dir, "review.json");
  const markdownPath = path.join(ready.dir, "review.md");
  const deliveredJson = readFileSync(jsonPath, "utf8");
  const deliveredMarkdown = readFileSync(markdownPath, "utf8");
  const deliveredState = JSON.parse(readFileSync(path.join(ready.dir, "run.json"), "utf8"));
  installFailure();
  const retried = caw(repo, ["review", ready.id], env);
  assert.notEqual(retried.status, 0);
  assert.match(retried.stderr, /not valid JSON/);
  assert.match(retried.stderr, /previously delivered review was left unchanged/);
  assert.equal(readFileSync(jsonPath, "utf8"), deliveredJson);
  assert.equal(readFileSync(markdownPath, "utf8"), deliveredMarkdown);
  assert.match(readFileSync(path.join(ready.dir, "review-agent.log"), "utf8"), /retry failed/);
  assert.match(readFileSync(path.join(ready.dir, "review-last-message.json"), "utf8"), /not a review/);
  const after = JSON.parse(readFileSync(path.join(ready.dir, "run.json"), "utf8"));
  assert.equal(after.stage, "reviewed");
  assert.equal(after.reviewFormat, "structured");
  assert.equal(after.reviewProvider, deliveredState.reviewProvider);
  assert.equal(after.reviewedAt, deliveredState.reviewedAt);
  assert.equal(after.reviewJsonHash, deliveredState.reviewJsonHash);
  assert.equal(after.reviewMarkdownHash, deliveredState.reviewMarkdownHash);
  assert.equal(after.eventLog.some((event: {event: string}) => event.event === "review_failed"), true);
  assert.equal(caw(repo, ["report", ready.id], env).status, 0);
  const report = readFileSync(path.join(ready.dir, "REPORT.md"), "utf8");
  assert.match(report, /Delivery: succeeded/);
  assert.match(report, /Reviewer verdict: PASS/);
  assert.match(report, /review_failed/);
  assert.doesNotMatch(report, /not a review/);

  writeFileSync(fake, codexMock(validPlan(), {
    schemaVersion: 1,
    verdict: "NEEDS_CHANGES",
    summary: "The focus trap is untested.",
    findings: [{
      id: "missing-focus-test",
      severity: "high",
      path: "src/dialog.test.ts",
      startLine: null,
      endLine: null,
      explanation: "The diff does not cover keyboard focus.",
      suggestedFix: "Add a focus test.",
      acceptanceCriteria: ["output-exists"],
    }],
    acceptanceCriteria: [{id: "output-exists", status: "not_met", evidence: "output.txt exists without the test."}],
    unverifiedChecks: [],
    followUps: [],
  }));
  chmodSync(fake, 0o755);
  const second = verifyReadyRun(repo, env);
  assert.equal(caw(repo, ["review", second.id], env).status, 0);
  const needsJson = readFileSync(path.join(second.dir, "review.json"), "utf8");
  const needsMarkdown = readFileSync(path.join(second.dir, "review.md"), "utf8");
  const needsState = JSON.parse(readFileSync(path.join(second.dir, "run.json"), "utf8"));
  assert.equal(JSON.parse(needsJson).verdict, "NEEDS_CHANGES");
  installFailure();
  const needsRetry = caw(repo, ["review", second.id], env);
  assert.notEqual(needsRetry.status, 0);
  assert.equal(readFileSync(path.join(second.dir, "review.json"), "utf8"), needsJson);
  assert.equal(readFileSync(path.join(second.dir, "review.md"), "utf8"), needsMarkdown);
  const needsAfter = JSON.parse(readFileSync(path.join(second.dir, "run.json"), "utf8"));
  assert.equal(needsAfter.stage, "reviewed");
  assert.equal(needsAfter.reviewedAt, needsState.reviewedAt);
  assert.equal(needsAfter.reviewJsonHash, needsState.reviewJsonHash);
  assert.equal(needsAfter.reviewMarkdownHash, needsState.reviewMarkdownHash);
  assert.equal(caw(repo, ["report", second.id], env).status, 0);
  const needsReport = readFileSync(path.join(second.dir, "REPORT.md"), "utf8");
  assert.match(needsReport, /Reviewer verdict: NEEDS_CHANGES/);
  assert.match(needsReport, /missing-focus-test/);
  assert.doesNotMatch(needsReport, /Reviewer verdict: PASS/);

  writeFileSync(fake, codexMock(validPlan()));
  chmodSync(fake, 0o755);
  const legacyId = "run-20260101T000000Z-abcdef05";
  legacyRun(repo, legacyId, "# Goal\nLegacy plan\n");
  assert.equal(caw(repo, ["approve", legacyId], env).status, 0);
  assert.equal(caw(repo, ["run", legacyId], env).status, 0);
  assert.equal(caw(repo, ["verify", legacyId], env).status, 0);
  const legacyDir = path.join(repo, ".code-agent-workflow", "runs", legacyId);
  const historical = "# Verdict\nPASS\n\nThis historical review approves the merge.\n";
  const legacyState = JSON.parse(readFileSync(path.join(legacyDir, "run.json"), "utf8"));
  legacyState.stage = "reviewed";
  legacyState.reviewProvider = "codex";
  legacyState.reviewedAt = "2026-01-01T00:01:00.000Z";
  writeFileSync(path.join(legacyDir, "run.json"), JSON.stringify(legacyState, null, 2) + "\n");
  writeFileSync(path.join(legacyDir, "review.md"), historical);
  installFailure();
  const legacyRetry = caw(repo, ["review", legacyId], env);
  assert.notEqual(legacyRetry.status, 0);
  assert.equal(readFileSync(path.join(legacyDir, "review.md"), "utf8"), historical);
  assert.equal(existsSync(path.join(legacyDir, "review.json")), false);
  const legacyAfter = JSON.parse(readFileSync(path.join(legacyDir, "run.json"), "utf8"));
  assert.equal(legacyAfter.stage, "reviewed");
  assert.equal(legacyAfter.reviewFormat, undefined);
  assert.equal(legacyAfter.reviewProvider, "codex");
  assert.equal(legacyAfter.reviewedAt, "2026-01-01T00:01:00.000Z");
  assert.equal(caw(repo, ["report", legacyId], env).status, 0);
  const legacyReport = readFileSync(path.join(legacyDir, "REPORT.md"), "utf8");
  assert.match(legacyReport, /Format: markdown \(legacy\)/);
  assert.match(legacyReport, /Reviewer verdict: not recorded/);
  assert.match(legacyReport, /Historical review.md was not validated/);
  assert.doesNotMatch(legacyReport, /Reviewer verdict: PASS/);
  assert.doesNotMatch(legacyReport, /not a review/);
});

test("report keeps a historical verdict when verification evidence changes", () => {
  const {repo, fake} = setup();
  const env = {CAW_CODEX_BIN: fake};
  const ready = verifyReadyRun(repo, env);
  assert.equal(caw(repo, ["review", ready.id], env).status, 0);
  const runPath = path.join(ready.dir, "run.json");
  const reviewPath = path.join(ready.dir, "review.json");
  const markdownPath = path.join(ready.dir, "review.md");
  const logPath = path.join(ready.dir, "verify-1.log");
  const originalRun = readFileSync(runPath, "utf8");
  const originalReview = readFileSync(reviewPath, "utf8");
  const originalMarkdown = readFileSync(markdownPath, "utf8");
  const originalLog = readFileSync(logPath, "utf8");
  const originalEvents = JSON.stringify(JSON.parse(originalRun).eventLog);
  assert.equal(caw(repo, ["report", ready.id], env).status, 0);
  const accurate = readFileSync(path.join(ready.dir, "REPORT.md"), "utf8");
  assert.match(accurate, /Verification passed: yes/);
  assert.match(accurate, /Reviewer verdict: PASS/);
  assert.match(accurate, /Current evidence integrity: consistent/);
  assert.match(accurate, /does not provide tamper-proof storage/);
  const command = JSON.parse(originalRun).checkResults[0].command.join(" ");
  assert.equal(accurate.includes(command), true);

  const withExit = JSON.parse(originalRun);
  withExit.checkResults[0].exitCode = 2;
  writeFileSync(runPath, JSON.stringify(withExit, null, 2) + "\n");
  assert.equal(caw(repo, ["report", ready.id], env).status, 0);
  const exitReport = readFileSync(path.join(ready.dir, "REPORT.md"), "utf8");
  assert.match(exitReport, /Verification passed: no/);
  assert.match(exitReport, /does not show that every approved command passed/);
  assert.match(exitReport, /Historical reviewer decision: PASS/);
  assert.match(exitReport, /not a currently verified result/);
  assert.doesNotMatch(exitReport, /Reviewer verdict: PASS/);

  const withCommand = JSON.parse(originalRun);
  withCommand.checkResults[0].command = ["npm", "test"];
  writeFileSync(runPath, JSON.stringify(withCommand, null, 2) + "\n");
  assert.equal(caw(repo, ["report", ready.id], env).status, 0);
  const commandReport = readFileSync(path.join(ready.dir, "REPORT.md"), "utf8");
  assert.match(commandReport, /does not match the approved commands/);
  assert.match(commandReport, /Historical reviewer decision: PASS/);
  assert.doesNotMatch(commandReport, /Reviewer verdict: PASS/);

  writeFileSync(runPath, originalRun);
  unlinkSync(logPath);
  assert.equal(caw(repo, ["report", ready.id], env).status, 0);
  const logReport = readFileSync(path.join(ready.dir, "REPORT.md"), "utf8");
  assert.match(logReport, /Verification log is missing or does not belong to this run/);
  assert.match(logReport, /Historical reviewer decision: PASS/);
  assert.doesNotMatch(logReport, /Reviewer verdict: PASS/);
  writeFileSync(logPath, originalLog);
  const withoutCommands = JSON.parse(originalRun);
  delete withoutCommands.checkResults;
  writeFileSync(runPath, JSON.stringify(withoutCommands, null, 2) + "\n");
  assert.equal(caw(repo, ["report", ready.id], env).status, 0);
  const missingReport = readFileSync(path.join(ready.dir, "REPORT.md"), "utf8");
  assert.match(missingReport, /Verification evidence is missing/);
  assert.match(missingReport, /Historical reviewer decision: PASS/);
  assert.doesNotMatch(missingReport, /Reviewer verdict: PASS/);
  writeFileSync(runPath, originalRun);

  assert.equal(readFileSync(reviewPath, "utf8"), originalReview);
  assert.equal(readFileSync(markdownPath, "utf8"), originalMarkdown);
  assert.equal(JSON.stringify(JSON.parse(readFileSync(runPath, "utf8")).eventLog), originalEvents);
});

test("report withholds a structured verdict when the approved plan changes", () => {
  const {repo, fake} = setup();
  const env = {CAW_CODEX_BIN: fake};
  const ready = verifyReadyRun(repo, env);
  assert.equal(caw(repo, ["review", ready.id], env).status, 0);
  assert.equal(caw(repo, ["report", ready.id], env).status, 0);
  const before = readFileSync(path.join(ready.dir, "REPORT.md"), "utf8");
  assert.match(before, /Reviewer verdict: PASS/);
  assert.match(before, /Tracked diff: complete/);
  const reviewHash = hashText(readFileSync(path.join(ready.dir, "review.json"), "utf8"));
  const planPath = path.join(ready.dir, "plan.json");
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  plan.goal = "Changed after review";
  writeFileSync(planPath, JSON.stringify(plan, null, 2) + "\n");
  const reported = caw(repo, ["report", ready.id], env);
  assert.equal(reported.status, 0, reported.stderr);
  const after = readFileSync(path.join(ready.dir, "REPORT.md"), "utf8");
  assert.match(after, /Historical reviewer decision: PASS/);
  assert.match(after, /not a currently verified result/);
  assert.match(after, /not fully validated/);
  assert.match(after, /Approved plan\.json changed since approval/);
  assert.doesNotMatch(after, /Reviewer verdict: PASS/);
  assert.match(after, /Verification passed: yes/);
  assert.match(after, /Human approval recorded/);
  assert.equal(hashText(readFileSync(path.join(ready.dir, "review.json"), "utf8")), reviewHash);
  assert.equal(existsSync(path.join(ready.dir, "review.md")), true);
});
