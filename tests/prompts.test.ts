import { test } from "node:test";
import assert from "node:assert/strict";
import { childProcessEnvironment } from "../src/environment.js";
import { executePrompt, planPrompt, reviewPrompt } from "../src/prompts.js";
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
  assert.doesNotMatch(prompt, /Do not run tests or shell commands/);
});

test("review can inspect source files without modifying them", () => {
  const prompt = reviewPrompt("Add a dialog.", "Implement the dialog.");
  assert.match(prompt, /source files/);
  assert.match(prompt, new RegExp(inspection));
  assert.match(prompt, /built-in read tools/);
  assert.match(prompt, /Do not modify files/);
  assert.match(prompt, /tests, builds, installations, project scripts, deployments, or network requests/);
  assert.match(prompt, /INSUFFICIENT_EVIDENCE/);
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
