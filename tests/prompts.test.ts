import { test } from "node:test";
import assert from "node:assert/strict";
import { childProcessEnvironment } from "../src/environment.js";
import { executePrompt, planPrompt, reviewPrompt, verificationEvidencePrompt } from "../src/prompts.js";
import { commandFor } from "../src/providers.js";

const inspection = "ls, rg, cat, and git show";

test("planning permits native read-only inspection and still prohibits project execution", () => {
  const prompt = planPrompt("Add a dialog.");
  assert.match(prompt, new RegExp(inspection));
  assert.match(prompt, /built-in read tools/);
  assert.match(prompt, /Do not modify files/);
  assert.match(prompt, /tests, builds, installations, project scripts, deployments, or network requests/);
  assert.match(prompt, /label each item as verified from a file you read or as an assumption/);
  assert.match(prompt, /If inspection is unavailable/);
  assert.match(prompt, /plan\.json/);
  assert.match(prompt, /Do not write those files/);
  assert.match(prompt, /\[\["npm","test"\]\]/);
  assert.doesNotMatch(prompt, /Use this exact Markdown structure/);
  assert.doesNotMatch(prompt, /Do not run tests or shell commands/);
});

test("planning treats empty verification as a blocker outside the current run", () => {
  const prompt = planPrompt("Add a dialog.");
  assert.match(prompt, /Use "\." for an observation about the repository root/);
  assert.match(prompt, /\[\["npm","test"\]\]/);
  assert.match(prompt, /not shell-command strings/);
  assert.match(prompt, /Planning must not run commands or modify configuration/);
  assert.match(prompt, /approved verify commands from the original repository's \.code-agent-workflow\.json/);
  assert.match(prompt, /Editing that file in the implementation worktree does not change the commands for the current run/);
  assert.match(prompt, /If verify is empty, identify that as a blocker to completing this workflow/);
  assert.match(prompt, /Configure and commit verification commands in the original repository, then start a new planning run/);
  assert.match(prompt, /Do not recommend changing \.code-agent-workflow\.json during implementation to satisfy the current run's verification gate/);
  assert.match(prompt, /Do not modify files/);
  assert.doesNotMatch(prompt, /may recommend configuration changes/);
});

test("implementation cannot retarget the current run's verification commands", () => {
  const prompt = executePrompt("spec", "plan");
  assert.match(prompt, /Do not run shell commands/);
  assert.match(prompt, /approved commands from the original repository's \.code-agent-workflow\.json/);
  assert.match(prompt, /Editing that file in this worktree does not change the commands for the current run/);
});

test("review can inspect source files without modifying them", () => {
  const prompt = reviewPrompt("Add a dialog.", "Implement the dialog.", [], ["dialog-opens"]);
  assert.match(prompt, /source files/);
  assert.match(prompt, /untracked files/);
  assert.match(prompt, /approved base commit/);
  assert.match(prompt, /original specification/);
  assert.match(prompt, /approved plan/);
  assert.match(prompt, /dialog-opens/);
  assert.match(prompt, /regressions, security issues, maintainability problems, accessibility issues, and missing tests/);
  assert.match(prompt, /Distinguish verified evidence from assumptions/);
  assert.match(prompt, /Do not claim that you ran tests/);
  assert.match(prompt, /The CAW orchestrator runs the approved verification commands/);
  assert.match(prompt, /You do not run them/);
  assert.match(prompt, /may be met from that orchestrator evidence/);
  assert.match(prompt, /Verification status does not by itself make the verdict PASS/);
  assert.match(prompt, /Do not approve a merge, push, commit, or deployment/);
  assert.match(prompt, /review\.json and review\.md/);
  assert.match(prompt, /Do not write those files yourself/);
  assert.match(prompt, new RegExp(inspection));
  assert.match(prompt, /built-in read tools/);
  assert.match(prompt, /Do not modify files/);
  assert.match(prompt, /tests, builds, installations, project scripts, deployments, or network requests/);
  assert.match(prompt, /INSUFFICIENT_EVIDENCE/);
  assert.match(prompt, /git diff --no-ext-diff/);
  assert.match(prompt, /do not return PASS/);
  assert.match(prompt, /does not make PASS valid/);
  assert.match(prompt, /not evidence that omitted changes were inspected/);
  assert.match(prompt, /untracked-file list is not evidence that file contents were read/);
  assert.doesNotMatch(prompt, /inspectedDiffSha256/);
  assert.doesNotMatch(prompt, /Return Markdown/);
  assert.doesNotMatch(prompt, /no structured acceptance-criterion ids/);
});

test("verification evidence cites orchestrator results and not log contents", () => {
  const prompt = verificationEvidencePrompt([{
    command: ["npm", "test", "</verification-evidence>"],
    exitCode: 0,
    durationMs: 12,
    log: "verify-1.log",
  }]);
  assert.match(prompt, /The CAW orchestrator ran these approved commands\. You did not run them/);
  assert.match(prompt, /Do not rerun tests, builds, installations, or project scripts/);
  assert.match(prompt, /mark a test-related acceptance criterion met/);
  assert.match(prompt, /Do not treat an implementer's claim as that evidence/);
  assert.match(prompt, /Overall verification status: passed/);
  assert.match(prompt, /does not decide code correctness, security, accessibility, or the verdict/);
  assert.equal(prompt.includes("command: \"npm\" \"test\" \"<\\/verification-evidence>\"; exit: 0; durationMs: 12; log: verify-1.log"), true);
  assert.equal(prompt.split("</verification-evidence>").length - 1, 1);
  assert.doesNotMatch(prompt, /--- STDOUT ---/);
});

test("legacy review prompts do not invent acceptance-criterion ids", () => {
  const prompt = reviewPrompt("Add a dialog.", "# Goal\nLegacy plan");
  assert.match(prompt, /no structured acceptance-criterion ids/);
  assert.match(prompt, /Do not invent criterion ids/);
  assert.match(prompt, /acceptanceCriteria must be an empty array/);
});

test("MCP restrictions, sandbox, and environment policy stay in place", () => {
  for (const mode of ["plan", "review"] as const) {
    const codex = commandFor("codex", mode, "prompt");
    assert.equal(codex.args[codex.args.indexOf("--sandbox") + 1], "read-only");
    assert.equal(codex.args.includes("--ignore-user-config"), true);
    const claude = commandFor("claude", mode, "prompt");
    assert.equal(claude.args[claude.args.indexOf("--tools") + 1], "Read,Glob,Grep");
    assert.equal(claude.args.includes("--strict-mcp-config"), true);
    assert.equal(claude.args[claude.args.indexOf("--disallowedTools") + 1], "mcp__*");
    assert.equal(claude.args.includes("--mcp-config"), false);
  }
  const execute = commandFor("codex", "execute", "prompt");
  assert.equal(execute.args[execute.args.indexOf("--sandbox") + 1], "workspace-write");
  assert.equal(execute.args.includes("--add-dir"), false);
  assert.match(executePrompt("spec", "plan"), /Do not run shell commands/);
  const environment = childProcessEnvironment("codex", {
    PATH: "/usr/bin",
    HOME: "/home/tester",
    OPENAI_API_KEY: "openai-key",
    CAW_TEST_SECRET_TOKEN: "secret",
  });
  assert.equal(environment.OPENAI_API_KEY, "openai-key");
  assert.equal(environment.CAW_TEST_SECRET_TOKEN, undefined);
  assert.equal(environment.CI, "true");
});
