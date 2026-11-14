import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { captureReferenceFiles, specFromPrompt } from "../src/references.js";
import { validateSpecification } from "../src/spec.js";
import type { ReferenceRepo } from "../src/types.js";

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, {cwd, encoding: "utf8"});
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function repository(name: string): ReferenceRepo {
  const root = mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  git(root, "init", "-q");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.com");
  writeFileSync(path.join(root, "quest.ts"), "export const quest = true;\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "prototype");
  return {path: root, commit: git(root, "rev-parse", "HEAD"), dirty: false};
}

test("a prompt becomes a valid specification without interpreting its headings", () => {
  const reference = repository("reference");
  const spec = specFromPrompt("Port the quest feature.\n## Scope\nDo not copy the prototype.", [reference]);
  assert.deepEqual(validateSpecification(spec), []);
  assert.match(spec, / {4}## Scope/);
  assert.match(spec, new RegExp(reference.commit));
});

test("cited reference files must exist inside the reference repository", () => {
  const reference = repository("reference");
  const outside = path.join(os.tmpdir(), `caw-outside-${process.pid}.txt`);
  writeFileSync(outside, "secret\n");
  symlinkSync(outside, path.join(reference.path, "leak.ts"));
  const plan = "# Reference files\n- quest.ts\n";
  const files = captureReferenceFiles(plan, [reference]);
  assert.equal(files[0]?.path, "quest.ts");
  assert.throws(() => captureReferenceFiles("# Reference files\n- missing.ts\n", [reference]), /Reference file does not exist: missing.ts/);
  assert.throws(() => captureReferenceFiles("# Reference files\n- leak.ts\n", [reference]), /not a file inside the repository/);
  assert.throws(() => captureReferenceFiles("# Reference files\n- ../quest.ts\n", [reference]), /relative path/);
});

test("the same relative path in two reference repositories is ambiguous", () => {
  const first = repository("one");
  const second = repository("two");
  assert.throws(() => captureReferenceFiles("# Reference files\n- quest.ts\n", [first, second]), /Ambiguous reference file: quest.ts/);
  mkdirSync(path.join(first.path, "src"));
  writeFileSync(path.join(first.path, "src", "only.ts"), "export {};\n");
  const prefixed = captureReferenceFiles(`# Reference files\n- ${path.basename(first.path)}/src/only.ts\n`, [first]);
  assert.equal(prefixed[0]?.path, "src/only.ts");
});
