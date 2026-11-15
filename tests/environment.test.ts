import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { childProcessEnvironment } from "../src/environment.js";
import { invokeAgent } from "../src/providers.js";

test("environment policies separate system, provider, and verification variables", () => {
  const source = {
    PATH: "/test/bin",
    HOME: "/test/home",
    CAW_TEST_SECRET_TOKEN: "unrelated-secret",
    CAW_CODEX_BIN: "/test/codex",
    OPENAI_API_KEY: "openai-key",
    CODEX_API_KEY: "codex-key",
    CODEX_ACCESS_TOKEN: "codex-token",
    CODEX_HOME: "/test/codex-home",
    ANTHROPIC_API_KEY: "anthropic-key",
    ANTHROPIC_CUSTOM_HEADERS: "X-Test: marker",
    CLAUDE_CONFIG_DIR: "/test/claude-home",
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_CODE_SKIP_BEDROCK_AUTH: "1",
    AWS_ACCESS_KEY_ID: "aws-key",
    HTTPS_PROXY: "https://proxy.example",
    http_proxy: "http://proxy.example",
    NO_PROXY: "localhost",
    no_proxy: "internal.example",
    NODE_EXTRA_CA_CERTS: "/test/ca.pem",
    ANTHROPIC_MODEL: "claude-test",
    CLAUDE_CODE_GIT_BASH_PATH: "C:\\\\Program Files\\\\Git\\\\bin\\\\bash.exe",
  };

  const codex = childProcessEnvironment("codex", source);
  assert.equal(codex.PATH, source.PATH);
  assert.equal(codex.HOME, source.HOME);
  assert.equal(codex.OPENAI_API_KEY, source.OPENAI_API_KEY);
  assert.equal(codex.CODEX_API_KEY, source.CODEX_API_KEY);
  assert.equal(codex.CODEX_ACCESS_TOKEN, source.CODEX_ACCESS_TOKEN);
  assert.equal(codex.CODEX_HOME, source.CODEX_HOME);
  assert.equal(codex.ANTHROPIC_API_KEY, undefined);
  assert.equal(codex.AWS_ACCESS_KEY_ID, undefined);
  assert.equal(codex.CAW_CODEX_BIN, undefined);
  assert.equal(codex.HTTPS_PROXY, undefined);
  assert.equal(codex.NODE_EXTRA_CA_CERTS, undefined);
  assert.equal(codex.ANTHROPIC_MODEL, undefined);
  assert.equal(codex.CLAUDE_CODE_GIT_BASH_PATH, undefined);
  assert.equal(codex.CAW_TEST_SECRET_TOKEN, undefined);
  assert.equal(codex.CI, "true");

  const claude = childProcessEnvironment("claude", source);
  assert.equal(claude.ANTHROPIC_API_KEY, source.ANTHROPIC_API_KEY);
  assert.equal(claude.CLAUDE_CONFIG_DIR, source.CLAUDE_CONFIG_DIR);
  assert.equal(claude.ANTHROPIC_CUSTOM_HEADERS, source.ANTHROPIC_CUSTOM_HEADERS);
  assert.equal(claude.CLAUDE_CODE_USE_BEDROCK, "1");
  assert.equal(claude.CLAUDE_CODE_SKIP_BEDROCK_AUTH, "1");
  assert.equal(claude.AWS_ACCESS_KEY_ID, source.AWS_ACCESS_KEY_ID);
  assert.equal(claude.OPENAI_API_KEY, undefined);
  assert.equal(claude.CODEX_API_KEY, undefined);
  assert.equal(claude.HTTPS_PROXY, source.HTTPS_PROXY);
  assert.equal(claude.http_proxy, source.http_proxy);
  assert.equal(claude.NO_PROXY, source.NO_PROXY);
  assert.equal(claude.no_proxy, source.no_proxy);
  assert.equal(claude.NODE_EXTRA_CA_CERTS, source.NODE_EXTRA_CA_CERTS);
  assert.equal(claude.ANTHROPIC_MODEL, source.ANTHROPIC_MODEL);
  assert.equal(claude.CLAUDE_CODE_GIT_BASH_PATH, source.CLAUDE_CODE_GIT_BASH_PATH);
  assert.equal(claude.CAW_TEST_SECRET_TOKEN, undefined);

  const claudeWithoutBedrock = childProcessEnvironment("claude", {
    ...source,
    CLAUDE_CODE_USE_BEDROCK: "",
  });
  assert.equal(claudeWithoutBedrock.CLAUDE_CODE_USE_BEDROCK, undefined);
  assert.equal(claudeWithoutBedrock.AWS_ACCESS_KEY_ID, undefined);

  for (const selector of [
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  ] as const) {
    const enabled = childProcessEnvironment("claude", {
      ...source,
      CLAUDE_CODE_USE_BEDROCK: undefined,
      [selector]: " YeS ",
      GOOGLE_APPLICATION_CREDENTIALS: "/test/google.json",
      ANTHROPIC_FOUNDRY_API_KEY: "foundry-key",
      ANTHROPIC_AWS_API_KEY: "anthropic-aws-key",
    });
    assert.equal(enabled[selector], "1");
    assert.equal(enabled.AWS_ACCESS_KEY_ID, selector === "CLAUDE_CODE_USE_VERTEX" || selector === "CLAUDE_CODE_USE_FOUNDRY" ? undefined : source.AWS_ACCESS_KEY_ID);
    assert.equal(enabled.GOOGLE_APPLICATION_CREDENTIALS, selector === "CLAUDE_CODE_USE_VERTEX" ? "/test/google.json" : undefined);
    assert.equal(enabled.ANTHROPIC_FOUNDRY_API_KEY, selector === "CLAUDE_CODE_USE_FOUNDRY" ? "foundry-key" : undefined);
    assert.equal(enabled.ANTHROPIC_AWS_API_KEY, selector === "CLAUDE_CODE_USE_ANTHROPIC_AWS" ? "anthropic-aws-key" : undefined);

    for (const value of ["0", "false", "no", "off", " FALSE ", "", "maybe", undefined]) {
      const disabled = childProcessEnvironment("claude", {
        ...source,
        CLAUDE_CODE_USE_BEDROCK: undefined,
        [selector]: value,
        GOOGLE_APPLICATION_CREDENTIALS: "/test/google.json",
        ANTHROPIC_FOUNDRY_API_KEY: "foundry-key",
        ANTHROPIC_AWS_API_KEY: "anthropic-aws-key",
      });
      assert.equal(disabled[selector], undefined);
      assert.equal(disabled.AWS_ACCESS_KEY_ID, undefined);
      assert.equal(disabled.GOOGLE_APPLICATION_CREDENTIALS, undefined);
      assert.equal(disabled.ANTHROPIC_FOUNDRY_API_KEY, undefined);
      assert.equal(disabled.ANTHROPIC_AWS_API_KEY, undefined);
    }
  }

  for (const kind of ["binary-detection", "git", "verification"] as const) {
    const environment = childProcessEnvironment(kind, source);
    assert.equal(environment.PATH, source.PATH);
    assert.equal(environment.HOME, source.HOME);
    assert.equal(environment.OPENAI_API_KEY, undefined);
    assert.equal(environment.CODEX_API_KEY, undefined);
    assert.equal(environment.ANTHROPIC_API_KEY, undefined);
    assert.equal(environment.AWS_ACCESS_KEY_ID, undefined);
    assert.equal(environment.HTTPS_PROXY, undefined);
    assert.equal(environment.NODE_EXTRA_CA_CERTS, undefined);
    assert.equal(environment.CLAUDE_CODE_GIT_BASH_PATH, undefined);
    assert.equal(environment.CLAUDE_CODE_USE_BEDROCK, undefined);
    assert.equal(environment.CAW_TEST_SECRET_TOKEN, undefined);
    assert.equal(environment.CI, kind === "verification" ? "true" : undefined);
  }
});

test("mock agents receive only their provider environment", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "caw-env-"));
  const codexCapture = path.join(directory, "codex.json");
  const claudeCapture = path.join(directory, "claude.json");
  const codexBin = mockAgent(path.join(directory, "codex.cjs"), codexCapture);
  const claudeBin = mockAgent(path.join(directory, "claude.cjs"), claudeCapture);
  const previous = new Map<string, string | undefined>();
  const variables = {
    CAW_CODEX_BIN: codexBin,
    CAW_CLAUDE_BIN: claudeBin,
    CAW_TEST_SECRET_TOKEN: "unrelated-secret",
    OPENAI_API_KEY: "openai-key",
    CODEX_API_KEY: "codex-key",
    ANTHROPIC_API_KEY: "anthropic-key",
    CLAUDE_CODE_OAUTH_TOKEN: "claude-oauth-token",
  };
  for (const [name, value] of Object.entries(variables)) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }

  try {
    const codex = await invokeAgent("codex", "plan", "test prompt", directory, path.join(directory, "codex.log"), 1);
    const claude = await invokeAgent("claude", "plan", "test prompt", directory, path.join(directory, "claude.log"), 1);
    assert.equal(codex.exitCode, 0);
    assert.equal(claude.exitCode, 0);

    const codexEnvironment = JSON.parse(readFileSync(codexCapture, "utf8"));
    assert.deepEqual(codexEnvironment, {
      secret: false,
      path: true,
      home: true,
      ci: true,
      openai: true,
      codexApi: true,
      anthropic: false,
      claudeOauth: false,
      codexOverride: false,
      claudeOverride: false,
    });

    const claudeEnvironment = JSON.parse(readFileSync(claudeCapture, "utf8"));
    assert.deepEqual(claudeEnvironment, {
      secret: false,
      path: true,
      home: true,
      ci: true,
      openai: false,
      codexApi: false,
      anthropic: true,
      claudeOauth: true,
      codexOverride: false,
      claudeOverride: false,
    });
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

function mockAgent(filename: string, capture: string): string {
  writeFileSync(filename, `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--version")) process.exit(0);
process.stdin.resume();
process.stdin.on("end", () => {
  const env = process.env;
  fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({
    secret: Object.hasOwn(env, "CAW_TEST_SECRET_TOKEN"),
    path: Boolean(env.PATH),
    home: Boolean(env.HOME || env.USERPROFILE),
    ci: env.CI === "true",
    openai: env.OPENAI_API_KEY === "openai-key",
    codexApi: env.CODEX_API_KEY === "codex-key",
    anthropic: env.ANTHROPIC_API_KEY === "anthropic-key",
    claudeOauth: env.CLAUDE_CODE_OAUTH_TOKEN === "claude-oauth-token",
    codexOverride: Object.hasOwn(env, "CAW_CODEX_BIN"),
    claudeOverride: Object.hasOwn(env, "CAW_CLAUDE_BIN"),
  }));
  console.log("ok");
});
`);
  chmodSync(filename, 0o755);
  return filename;
}
