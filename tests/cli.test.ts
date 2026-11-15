import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, realpathSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { hashText, newId } from "../src/paths.js";
import { commandFor } from "../src/providers.js";
import { renderPlan } from "../src/plan.js";
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
function codexMock(plan: unknown): string {
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
  console.log("# Verdict\\nPASS\\n# Findings\\nNo findings");
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
  assert.match(report, /Human approval recorded/);
  assert.match(report, /PASS/);
  assert.match(report, /output.txt/);
  const final = JSON.parse(readFileSync(path.join(base, "run.json"), "utf8"));
  assert.equal(final.stage, "reviewed");
  assert.equal(final.planFormat, "structured");
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
    .replace("__PLAN_TEXT__", JSON.stringify(JSON.stringify(plan))));
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
  console.log("# Verdict\\nPASS\\n# Findings\\nNo findings");
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
});
