import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { hasBinary } from "../src/providers.js";

// Both tests invoke the installed Codex CLI. They stay skipped unless
// CAW_MCP_PROVIDER_PROBE=1, so npm test does not require Codex and does not
// read a host keyring. `codex mcp list` has no --ignore-user-config flag and
// does not start the server. The exec comparison is the launch check.

const codexBin = process.env.CAW_CODEX_BIN || "codex";
const skipProviderProbe = process.env.CAW_MCP_PROVIDER_PROBE === "1"
  ? false
  : "set CAW_MCP_PROVIDER_PROBE=1 in a disposable environment with no Codex login, keyring entry, or managed policy";

function fixture(): { root: string; home: string; codexHome: string; marker: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "caw-mcp-probe-"));
  const home = path.join(root, "home");
  const codexHome = path.join(root, "codex-home");
  const marker = path.join(root, "marker");
  mkdirSync(home);
  mkdirSync(codexHome);
  const server = path.join(codexHome, "server.mjs");
  writeFileSync(server, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "started\\n");\nprocess.exit(0);\n`);
  writeFileSync(path.join(codexHome, "config.toml"), `[mcp_servers.probe]\ncommand = "node"\nargs = [${JSON.stringify(server)}]\n`);
  return { root, home, codexHome, marker };
}

function probeEnv(paths: { root: string; home: string; codexHome: string }): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: paths.home,
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
    TMPDIR: paths.root,
    CODEX_HOME: paths.codexHome,
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
  };
}

test("installed Codex lists a disposable local MCP server without starting it", { skip: skipProviderProbe }, () => {
  assert.equal(hasBinary(codexBin), true, "codex is not installed");
  const paths = fixture();
  const result = spawnSync(codexBin, ["mcp", "list", "--json"], {
    cwd: paths.root,
    encoding: "utf8",
    timeout: 15000,
    shell: false,
    env: probeEnv(paths),
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const listed = JSON.parse(result.stdout) as Array<{ name?: string; enabled?: boolean }>;
  assert.equal(listed.some(server => server.name === "probe" && server.enabled === true), true);
  assert.equal(existsSync(paths.marker), false);
});

function execProbe(paths: { root: string; home: string; codexHome: string }, ignoreUserConfig: boolean) {
  return spawnSync(codexBin, [
    "exec",
    ...(ignoreUserConfig ? ["--ignore-user-config"] : []),
    "--ephemeral",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "Reply with the single word OK.",
  ], {
    cwd: paths.root,
    encoding: "utf8",
    timeout: 8000,
    shell: false,
    env: probeEnv(paths),
  });
}

test("opt-in Codex exec does not start a user-config MCP server", { skip: skipProviderProbe }, () => {
  assert.equal(hasBinary(codexBin), true, "codex is not installed");
  const visible = fixture();
  const visibleRun = execProbe(visible, false);
  const visibleOutput = `${visibleRun.stdout ?? ""}\n${visibleRun.stderr ?? ""}`;
  assert.equal(
    existsSync(visible.marker),
    true,
    `probe inconclusive: Codex did not launch the fixture server, so --ignore-user-config was not tested.\n${visibleOutput}`,
  );

  const hidden = fixture();
  const hiddenRun = execProbe(hidden, true);
  const hiddenOutput = `${hiddenRun.stdout ?? ""}\n${hiddenRun.stderr ?? ""}`;
  assert.equal(existsSync(hidden.marker), false, "Codex started the user-config MCP server despite --ignore-user-config");
  assert.doesNotMatch(hiddenOutput, /Failed to synchronize managed preferences|managed preferences/i);
});
