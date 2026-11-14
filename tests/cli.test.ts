import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, realpathSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { hashText, newId } from "../src/paths.js";
import { commandFor } from "../src/providers.js";
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
  config.verify = [[process.execPath, "-e", "require('node:fs').existsSync('output.txt') || process.exit(2)"]];
  writeFileSync(configFile, JSON.stringify(config, null, 2));
  writeFileSync(path.join(repo, "specs", "ready-feature.md"), readySpec);
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "workflow config and sample spec");
  const fake = path.join(repo, ".code-agent-workflow", "mock-agent.cjs");
  mkdirSync(path.dirname(fake), {recursive: true});
  writeFileSync(fake, `#!/usr/bin/env node\nconst fs=require('node:fs');\nconst args=process.argv.slice(2);\nif(args.includes('--version')){console.log('mock 1.0');process.exit(0)}\nconst text=fs.readFileSync(0,'utf8');\nif(text.includes('ROLE: Implementer')){fs.writeFileSync('output.txt','feature implemented\\n');console.log('Implemented the feature')}\nelse if(text.includes('ROLE: Independent code reviewer')){console.log('# Verdict\\nPASS\\n# Findings\\nNo findings')}\nelse if(text.includes('ROLE: Repository-aware planning agent')){console.log('# Goal\\nImplement specification\\n# Implementation steps\\n1. Create output.txt')}\nelse {console.error('Unexpected prompt');process.exit(4)}\n`);
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
  result = caw(repo, ["verify", runId], env);
  assert.equal(result.status, 0, result.stderr);
  result = caw(repo, ["review", runId], env);
  assert.equal(result.status, 0, result.stderr);
  result = caw(repo, ["report", runId], env);
  assert.equal(result.status, 0, result.stderr);
  const report = readFileSync(path.join(base, "REPORT.md"), "utf8");
  assert.match(report, /Human approval recorded/);
  assert.match(report, /PASS/);
  assert.match(report, /output.txt/);
  const final = JSON.parse(readFileSync(path.join(base, "run.json"), "utf8"));
  assert.equal(final.stage, "reviewed");
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

function pair(mock: string) {
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
  writeFileSync(fake, mock);
  chmodSync(fake, 0o755);
  return {parent, repo, reference, fake};
}

const portMock = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("mock 1.0"); process.exit(0); }
if (process.env.CAW_ARGV_FILE) fs.appendFileSync(process.env.CAW_ARGV_FILE, process.argv.join(" ") + "\\n");
const text = fs.readFileSync(0, "utf8");
if (process.env.CAW_STDIN_FILE) fs.appendFileSync(process.env.CAW_STDIN_FILE, text + "\\n---\\n");
if (text.includes("ROLE: Implementer")) {
  fs.writeFileSync("output.txt", "feature implemented\\n");
  console.log("Implemented the feature");
} else if (text.includes("ROLE: Independent code reviewer")) {
  console.log("# Verdict\\nPASS\\n# Findings\\nNo findings");
} else if (text.includes("ROLE: Repository-aware planning agent")) {
  if (process.env.CAW_MUTATE_REFERENCE) fs.appendFileSync(process.env.CAW_MUTATE_REFERENCE, "\\nmutated\\n");
  const cited = process.env.CAW_CITED_FILE || "quest.ts";
  console.log("# Goal\\nPort quest\\n# Reference files\\n- " + cited + "\\n");
} else { console.error("Unexpected prompt"); process.exit(4); }
`;

test("prompt and reference repository produce a checked plan and read-only execution", () => {
  const {parent, repo, reference} = pair(portMock);
  const argvFile = path.join(parent, "argv.log");
  const stdinFile = path.join(parent, "stdin.log");
  const env = {CAW_CODEX_BIN: path.join(repo, ".code-agent-workflow", "mock-agent.cjs"), CAW_ARGV_FILE: argvFile, CAW_STDIN_FILE: stdinFile};
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
  assert.match(readFileSync(argvFile, "utf8"), /--sandbox read-only/);
  assert.ok(readFileSync(argvFile, "utf8").includes(`--add-dir ${realpathSync(reference)}`));
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
  const {repo} = pair(portMock);
  const env = {CAW_CODEX_BIN: path.join(repo, ".code-agent-workflow", "mock-agent.cjs"), CAW_CITED_FILE: "missing.ts"};
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
  const {repo, reference} = pair(portMock);
  const env = {CAW_CODEX_BIN: path.join(repo, ".code-agent-workflow", "mock-agent.cjs"), CAW_MUTATE_REFERENCE: path.join(reference, "quest.ts")};
  const planned = caw(repo, ["plan", "--prompt", "Port the quest feature.", "--reference", "../repo-b"], env);
  assert.notEqual(planned.status, 0);
  assert.match(planned.stderr, /Reference repository changed during read-only access/);
  const runs = readdirSync(path.join(repo, ".code-agent-workflow", "runs"));
  assert.equal(runs.length, 1);
  assert.equal(existsSync(path.join(repo, ".code-agent-workflow", "runs", runs[0]!, "plan.md")), false);
});
