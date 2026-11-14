import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { git, hashText, worktreeHash } from "./paths.js";
import type { ReferenceFile, ReferenceRepo } from "./types.js";

export function resolveReference(start: string, requested: string, targetRoot: string): ReferenceRepo {
  const input = path.resolve(start, requested);
  if (!existsSync(input) || !statSync(input).isDirectory()) throw new Error(`Reference repository not found: ${requested}`);
  let root: string;
  try {
    root = realpathSync(git(input, ["rev-parse", "--show-toplevel"]));
  } catch {
    throw new Error(`Reference is not a Git repository: ${requested}`);
  }
  if (root === realpathSync(targetRoot)) throw new Error("Reference repository must be different from the current repository");
  let commit: string;
  try {
    commit = git(root, ["rev-parse", "HEAD"]);
  } catch {
    throw new Error(`Reference repository has no commits: ${root}`);
  }
  return { path: root, commit, dirty: git(root, ["status", "--porcelain", "--untracked-files=all"]).length > 0 };
}

export function specFromPrompt(prompt: string, references: ReferenceRepo[]): string {
  const quoted = prompt.trim().split(/\r?\n/).map(line => `    ${line}`).join("\n");
  const listed = references.map(reference => `- ${reference.path} @ ${reference.commit}${reference.dirty ? " (uncommitted changes are visible)" : ""}`).join("\n");
  return `# Port request

## Objective
${quoted}

## Scope
Reimplement the requested behavior in this repository using its existing patterns. Reference repositories are read-only evidence. Do not modify them or copy their code wholesale.

## Acceptance criteria
- [ ] The requested behavior is implemented in this repository and passes its configured verification.
- [ ] The reference repositories remain unchanged.

## References
${listed || "- None"}
`;
}

export function referenceFingerprint(reference: ReferenceRepo): string {
  const head = git(reference.path, ["rev-parse", "HEAD"]);
  return hashText(`${head}\n${worktreeHash(reference.path, reference.commit)}`);
}

export function assertReferenceStable(references: ReferenceRepo[], before: string[]): void {
  if (before.length !== references.length) throw new Error("Reference fingerprint mismatch");
  for (let index = 0; index < references.length; index++) {
    const reference = references[index]!;
    if (referenceFingerprint(reference) !== before[index]) {
      throw new Error(`Reference repository changed during read-only access: ${reference.path}`);
    }
  }
}

export function captureReferenceFiles(plan: string, references: ReferenceRepo[]): ReferenceFile[] {
  const listed = referencePaths(plan);
  if (references.length === 0) {
    if (listed.length > 0) throw new Error("Plan cites reference files, but no reference repository was provided");
    return [];
  }
  if (listed.length === 0) throw new Error("Plan must list at least one existing file under # Reference files");
  const files = listed.map(item => resolveCitedFile(item, references));
  const seen = new Set<string>();
  for (const file of files) {
    const key = `${file.repository}\n${file.path}`;
    if (seen.has(key)) throw new Error(`Duplicate reference file: ${file.path}`);
    seen.add(key);
  }
  return files;
}

export function assertReferenceFilesUnchanged(files: ReferenceFile[]): void {
  for (const file of files) {
    const current = readCitedFile(file);
    if (current.sha256 !== file.sha256) throw new Error(`Reference file changed since planning: ${file.path}`);
  }
}

export function referenceEvidence(files: ReferenceFile[], budget = 48_000): string {
  assertReferenceFilesUnchanged(files);
  const parts: string[] = [];
  let remaining = budget;
  for (const file of files) {
    if (remaining <= 0) {
      parts.push(`<reference-file repository="${file.repository}" path="${file.path}" sha256="${file.sha256}">\n[omitted after evidence limit]\n</reference-file>`);
      continue;
    }
    const bytes = readFileSync(path.resolve(file.repository, file.path));
    const text = bytes.includes(0) ? "[binary file omitted]" : bytes.toString("utf8");
    const body = text.length > remaining ? `${text.slice(0, remaining)}\n[truncated]` : text;
    remaining -= body.length;
    parts.push(`<reference-file repository="${file.repository}" path="${file.path}" sha256="${file.sha256}">\n${body}\n</reference-file>`);
  }
  return parts.join("\n\n");
}

function referencePaths(plan: string): string[] {
  const lines = sectionBody(plan, "reference files");
  if (!lines) return [];
  return lines.flatMap(line => {
    const item = line.trim().replace(/^(?:[-*+]|\d+[.)])\s+/, "").replace(/^`([^`]+)`$/, "$1").replace(/[`*]/g, "").trim();
    if (!item || /^none$/i.test(item)) return [];
    return [item.replace(/^\.\//, "")];
  });
}

function sectionBody(markdown: string, title: string): string[] | null {
  let level = 0;
  let collecting = false;
  const body: string[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line.trim());
    if (heading?.[1] && heading[2]) {
      const current = heading[1].length;
      if (collecting && current <= level) break;
      if (!collecting && heading[2].replace(/:$/, "").trim().toLowerCase() === title) {
        collecting = true;
        level = current;
      }
      continue;
    }
    if (collecting) body.push(line);
  }
  return collecting ? body : null;
}

function resolveCitedFile(listed: string, references: ReferenceRepo[]): ReferenceFile {
  if (path.isAbsolute(listed) || listed.split(/[\\/]/).includes("..")) throw new Error(`Reference file must be a relative path inside a reference repository: ${listed}`);
  const hits: ReferenceFile[] = [];
  let outside = false;
  for (const reference of references) {
    const base = path.basename(reference.path);
    const relative = listed === base || listed.startsWith(`${base}/`) ? listed.slice(base.length + 1) : listed;
    if (!relative) continue;
    const full = path.resolve(reference.path, ...relative.split("/"));
    if (!existsSync(full)) continue;
    if (!containedFile(reference.path, full)) {
      outside = true;
      continue;
    }
    const bytes = readFileSync(full);
    hits.push({ repository: reference.path, path: relative, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  if (hits.length > 1) throw new Error(`Ambiguous reference file: ${listed}`);
  const hit = hits[0];
  if (!hit) throw new Error(outside ? `Reference file is not a file inside the repository: ${listed}` : `Reference file does not exist: ${listed}`);
  return hit;
}

function containedFile(root: string, full: string): boolean {
  const stat = lstatSync(full);
  if (!stat.isFile() && !stat.isSymbolicLink()) return false;
  const realRoot = realpathSync(root);
  const realFile = realpathSync(full);
  if (!(realFile === realRoot || realFile.startsWith(realRoot + path.sep))) return false;
  return stat.isFile() || lstatSync(realFile).isFile();
}

function readCitedFile(file: ReferenceFile): ReferenceFile {
  const full = path.resolve(file.repository, file.path);
  if (!existsSync(full) || !containedFile(file.repository, full)) throw new Error(`Reference file is no longer available: ${file.path}`);
  const bytes = readFileSync(full);
  return { ...file, sha256: createHash("sha256").update(bytes).digest("hex") };
}
