import path from "node:path";
import { bullets, inlineCode, literalText, prefixed, section, subsection } from "./markdown.js";
import { hashText } from "./paths.js";

export const REVIEW_SCHEMA_VERSION = 1;
export const REVIEW_DIFF_PROMPT_LIMIT = 120_000;
export const REVIEW_UNTRACKED_PROMPT_LIMIT = 120_000;

export const REVIEW_VERDICTS = ["PASS", "NEEDS_CHANGES", "INSUFFICIENT_EVIDENCE"] as const;
export const FINDING_SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export const CRITERION_STATUSES = ["met", "not_met", "uncertain"] as const;
const BLOCKING_SEVERITIES = ["critical", "high"] as const;

export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];
export type CriterionStatus = (typeof CRITERION_STATUSES)[number];

export interface ReviewFinding {
  id: string;
  severity: FindingSeverity;
  path: string | null;
  startLine: number | null;
  endLine: number | null;
  explanation: string;
  suggestedFix: string;
  acceptanceCriteria: string[];
}

export interface ReviewCriterion {
  id: string;
  status: CriterionStatus;
  evidence: string;
}

export interface CodeReview {
  schemaVersion: 1;
  verdict: ReviewVerdict;
  summary: string;
  findings: ReviewFinding[];
  acceptanceCriteria: ReviewCriterion[];
  unverifiedChecks: string[];
  followUps: string[];
}

export interface BoundedReviewDiff {
  embedded: string;
  truncated: boolean;
  omittedCharacters: number;
  sha256: string;
}

export interface BoundedUntrackedFiles {
  embedded: string;
  truncated: boolean;
  omittedEntries: number;
}

export interface ReviewDiffPrompt {
  text: string;
  diffTruncated: boolean;
  diffSha256: string;
  untrackedTruncated: boolean;
}

/** Prompt bounds. A fingerprint is not evidence that omitted text was inspected. */
export interface ReviewEvidence {
  truncatedDiff?: boolean;
  truncatedUntracked?: boolean;
}

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const MAX_LINE = 1_000_000;

function text(description: string): Record<string, unknown> {
  return {type: "string", description};
}

function nullableText(description: string): Record<string, unknown> {
  return {type: ["string", "null"], description};
}

function nullableLine(description: string): Record<string, unknown> {
  return {type: ["integer", "null"], description};
}

export const REVIEW_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  description: "Version 1 code review. Matching this schema does not make the statements true, and the verdict does not approve a merge.",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "verdict",
    "summary",
    "findings",
    "acceptanceCriteria",
    "unverifiedChecks",
    "followUps",
  ],
  properties: {
    schemaVersion: {type: "integer", enum: [REVIEW_SCHEMA_VERSION], description: "Review contract version. Only 1 is accepted."},
    verdict: {
      type: "string",
      enum: [...REVIEW_VERDICTS],
      description: "Advisory verdict. PASS cannot include critical or high findings or an acceptance criterion that is not met. NEEDS_CHANGES needs a finding or a criterion marked not_met. INSUFFICIENT_EVIDENCE must name missing evidence in unverifiedChecks.",
    },
    summary: text("What the review concluded. This is not merge approval."),
    findings: {
      type: "array",
      description: "Actionable findings. critical and high block a PASS verdict. Medium, low, and info do not.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "severity", "path", "startLine", "endLine", "explanation", "suggestedFix", "acceptanceCriteria"],
        properties: {
          id: text("Stable identifier: a letter, then letters, numbers, hyphens, or underscores."),
          severity: {type: "string", enum: [...FINDING_SEVERITIES]},
          path: nullableText("Repository-relative path, or null when the finding is not about one file. Use null for repository-wide behavior. A deleted file may still be named. Do not invent a path."),
          startLine: nullableLine("First affected line, starting at 1, or null. A line requires a path."),
          endLine: nullableLine("Last affected line, or null for a single line or no line. Requires startLine and must not precede it."),
          explanation: text("What is wrong or notable, based on evidence you inspected."),
          suggestedFix: text("The change that would address this finding."),
          acceptanceCriteria: {
            type: "array",
            items: text("Id of a related acceptance criterion from the approved plan."),
            description: "Related acceptance-criterion ids. Empty when none apply. Do not invent ids.",
          },
        },
      },
    },
    acceptanceCriteria: {
      type: "array",
      description: "Coverage for every acceptance-criterion id in a structured plan. Empty when the approved plan has no structured ids. Do not invent ids.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "status", "evidence"],
        properties: {
          id: text("Acceptance-criterion id copied from the approved plan."),
          status: {type: "string", enum: [...CRITERION_STATUSES]},
          evidence: text("What was inspected, or why the status is uncertain."),
        },
      },
    },
    unverifiedChecks: {
      type: "array",
      items: text("Evidence the reviewer could not establish. Required for INSUFFICIENT_EVIDENCE."),
      description: "Missing evidence and checks the reviewer did not perform. Do not claim tests were run.",
    },
    followUps: {
      type: "array",
      items: text("A recommended next action for a person. This does not schedule work or approve a merge."),
    },
  },
};

export class ReviewValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(issues.map(issue => `- ${issue}`).join("\n"));
    this.name = "ReviewValidationError";
    this.issues = issues;
  }
}

/**
 * `expectedCriterionIds` are the ids from a structured plan.
 * Pass an empty array for a legacy plan that has no structured ids.
 * This function does not invent ids.
 */
export function boundedReviewDiff(diff: string): BoundedReviewDiff {
  const truncated = diff.length > REVIEW_DIFF_PROMPT_LIMIT;
  const embedded = truncated ? diff.slice(0, REVIEW_DIFF_PROMPT_LIMIT) : diff;
  return {embedded, truncated, omittedCharacters: diff.length - embedded.length, sha256: hashText(diff)};
}

export function boundedUntrackedFiles(untracked: string): BoundedUntrackedFiles {
  if (untracked.length <= REVIEW_UNTRACKED_PROMPT_LIMIT) {
    return {embedded: untracked, truncated: false, omittedEntries: 0};
  }
  const entries = untracked.split("\n");
  const kept: string[] = [];
  let size = 0;
  for (const entry of entries) {
    const next = size + (kept.length > 0 ? 1 : 0) + entry.length;
    if (next > REVIEW_UNTRACKED_PROMPT_LIMIT) break;
    kept.push(entry);
    size = next;
  }
  return {embedded: kept.join("\n"), truncated: true, omittedEntries: entries.length - kept.length};
}

export function reviewDiffPrompt(diff: string, baseCommit: string, untracked: string): ReviewDiffPrompt {
  const bounded = boundedReviewDiff(diff);
  const files = boundedUntrackedFiles(untracked);
  const diffNotice = bounded.truncated
    ? `The tracked diff is incomplete. ${bounded.omittedCharacters} characters after the embedded prefix were omitted to keep this prompt bounded. The embedded prefix is not the full change against ${baseCommit}. You may inspect the omitted changes with this read-only command: git diff --no-ext-diff ${baseCommit}. You may also use the provider's built-in read tools, ls, rg, cat, and git show. Do not modify files. PASS is not accepted while this embedded diff is truncated. A SHA-256 of the complete diff is diagnostic provenance and does not establish that the omitted changes were inspected. Use NEEDS_CHANGES or INSUFFICIENT_EVIDENCE and name the omitted diff in unverifiedChecks when you cannot review it.`
    : "The tracked diff below is complete in this prompt.";
  const fileNotice = files.truncated
    ? `The untracked-file list is incomplete. ${files.omittedEntries} entries were omitted to keep this prompt bounded. The embedded names are not the full untracked set. The list does not establish that file contents were inspected. PASS is not accepted while entries are omitted.`
    : "The untracked-file list below names every untracked path returned for this worktree. The list does not establish that file contents were inspected.";
  return {
    diffTruncated: bounded.truncated,
    diffSha256: bounded.sha256,
    untrackedTruncated: files.truncated,
    text: `\n${diffNotice}\n<git-diff truncated="${bounded.truncated}" omitted-characters="${bounded.omittedCharacters}">\n${bounded.embedded}\n</git-diff>\n${fileNotice}\n<untracked-files truncated="${files.truncated}" omitted-entries="${files.omittedEntries}">\n${files.embedded}\n</untracked-files>\nUse file read tools to inspect any untracked source files and understand context.\n`,
  };
}

export function validateReview(input: unknown, expectedCriterionIds: readonly string[], evidence: ReviewEvidence = {}): CodeReview {
  if (!isRecord(input)) throw new ReviewValidationError(["review: must be a JSON object"]);
  if (Object.hasOwn(input, "schemaVersion") && input.schemaVersion !== REVIEW_SCHEMA_VERSION) {
    throw new ReviewValidationError([`schemaVersion: unsupported version ${formatValue(input.schemaVersion)}; expected ${REVIEW_SCHEMA_VERSION}`]);
  }

  const issues: string[] = [];
  rejectUnknown(input, [
    "schemaVersion",
    "verdict",
    "summary",
    "findings",
    "acceptanceCriteria",
    "unverifiedChecks",
    "followUps",
  ], "", issues);

  if (!Object.hasOwn(input, "schemaVersion")) issues.push("schemaVersion: required");
  const verdict = readVerdict(input, issues);
  const summary = readText(input, "summary", issues) ?? "";
  const findings = parseFindings(input.findings, Object.hasOwn(input, "findings"), expectedCriterionIds, issues);
  const acceptanceCriteria = parseCoverage(input.acceptanceCriteria, Object.hasOwn(input, "acceptanceCriteria"), expectedCriterionIds, issues);
  const unverifiedChecks = readStringList(input, "unverifiedChecks", issues);
  const followUps = readStringList(input, "followUps", issues);
  if (issues.length === 0 && verdict) {
    checkVerdict(verdict, findings, acceptanceCriteria, unverifiedChecks, issues);
    checkPromptEvidence(verdict, evidence, issues);
  }
  if (issues.length > 0 || !verdict) throw new ReviewValidationError(issues.length > 0 ? issues : ["verdict: required"]);
  return {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    verdict,
    summary,
    findings,
    acceptanceCriteria,
    unverifiedChecks,
    followUps,
  };
}

export function canonicalReviewJson(review: CodeReview): string {
  return `${JSON.stringify(review, null, 2)}\n`;
}

export function renderReview(review: CodeReview): string {
  return [
    section("Verdict", review.verdict),
    section("Summary", literalText(review.summary)),
    section("Findings", renderFindings(review.findings)),
    section("Acceptance criteria", renderCoverage(review.acceptanceCriteria)),
    section("Unverified checks", bullets(review.unverifiedChecks)),
    section("Recommended follow-ups", bullets(review.followUps)),
  ].join("\n\n") + "\n";
}

export function reviewLocation(finding: ReviewFinding): string {
  if (!finding.path) return "repository-wide";
  if (finding.startLine === null) return finding.path;
  if (finding.endLine === null || finding.endLine === finding.startLine) return `${finding.path}:${finding.startLine}`;
  return `${finding.path}:${finding.startLine}-${finding.endLine}`;
}

function checkVerdict(
  verdict: ReviewVerdict,
  findings: readonly ReviewFinding[],
  coverage: readonly ReviewCriterion[],
  unverifiedChecks: readonly string[],
  issues: string[],
): void {
  if (verdict === "PASS") {
    for (const finding of findings) {
      if (isBlocking(finding.severity)) {
        issues.push(`verdict: PASS cannot include ${finding.severity} finding ${JSON.stringify(finding.id)}`);
      }
    }
    for (const criterion of coverage) {
      if (criterion.status !== "met") {
        issues.push(`verdict: PASS cannot include acceptance criterion ${JSON.stringify(criterion.id)} with status ${criterion.status}`);
      }
    }
    return;
  }
  if (verdict === "NEEDS_CHANGES") {
    const actionable = findings.length > 0 || coverage.some(criterion => criterion.status === "not_met");
    if (!actionable) issues.push("verdict: NEEDS_CHANGES must include a finding or an acceptance criterion marked not_met");
    return;
  }
  if (unverifiedChecks.length === 0) {
    issues.push("verdict: INSUFFICIENT_EVIDENCE must list the missing evidence in unverifiedChecks");
  }
}

function checkPromptEvidence(verdict: ReviewVerdict, evidence: ReviewEvidence, issues: string[]): void {
  if (verdict !== "PASS") return;
  if (evidence.truncatedDiff) {
    issues.push("verdict: PASS is not accepted because the tracked diff was truncated. A SHA-256 of the complete diff is diagnostic provenance and does not establish that the omitted changes were inspected. Use NEEDS_CHANGES or INSUFFICIENT_EVIDENCE.");
  }
  if (evidence.truncatedUntracked) {
    issues.push("verdict: PASS is not accepted because the untracked-file list was truncated. That list does not establish that file contents were inspected. Use NEEDS_CHANGES or INSUFFICIENT_EVIDENCE.");
  }
}

function parseFindings(value: unknown, present: boolean, expectedCriterionIds: readonly string[], issues: string[]): ReviewFinding[] {
  if (!present) {
    issues.push("findings: required");
    return [];
  }
  if (!Array.isArray(value)) {
    issues.push("findings: must be an array");
    return [];
  }
  const findings: ReviewFinding[] = [];
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    const field = `findings[${index}]`;
    if (!isRecord(item)) {
      issues.push(`${field}: must be an object`);
      continue;
    }
    rejectUnknown(item, ["id", "severity", "path", "startLine", "endLine", "explanation", "suggestedFix", "acceptanceCriteria"], field, issues);
    const id = readIdentifier(item, "id", `${field}.id`, issues);
    if (id && seen.has(id)) issues.push(`${field}.id: duplicate identifier ${JSON.stringify(id)}`);
    if (id) seen.add(id);
    const severity = readSeverity(item, `${field}.severity`, issues);
    const location = readLocation(item, field, issues);
    const explanation = readText(item, "explanation", issues, `${field}.explanation`);
    const suggestedFix = readText(item, "suggestedFix", issues, `${field}.suggestedFix`);
    const acceptanceCriteria = readCriterionRefs(item, `${field}.acceptanceCriteria`, expectedCriterionIds, issues);
    if (!id || !severity || !location || !explanation || !suggestedFix || !acceptanceCriteria) continue;
    findings.push({
      id,
      severity,
      path: location.path,
      startLine: location.startLine,
      endLine: location.endLine,
      explanation,
      suggestedFix,
      acceptanceCriteria,
    });
  }
  return findings;
}

function parseCoverage(value: unknown, present: boolean, expectedCriterionIds: readonly string[], issues: string[]): ReviewCriterion[] {
  if (!present) {
    issues.push("acceptanceCriteria: required");
    return [];
  }
  if (!Array.isArray(value)) {
    issues.push("acceptanceCriteria: must be an array");
    return [];
  }
  const expected = new Set(expectedCriterionIds);
  const coverage: ReviewCriterion[] = [];
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    const field = `acceptanceCriteria[${index}]`;
    if (!isRecord(item)) {
      issues.push(`${field}: must be an object`);
      continue;
    }
    rejectUnknown(item, ["id", "status", "evidence"], field, issues);
    const id = readIdentifier(item, "id", `${field}.id`, issues);
    if (id && seen.has(id)) issues.push(`${field}.id: duplicate identifier ${JSON.stringify(id)}`);
    if (id) seen.add(id);
    if (id && !expected.has(id)) issues.push(`${field}.id: unknown acceptance criterion ${JSON.stringify(id)}`);
    const status = readStatus(item, `${field}.status`, issues);
    const evidence = readText(item, "evidence", issues, `${field}.evidence`);
    if (!id || !status || !evidence) continue;
    coverage.push({id, status, evidence});
  }
  for (const id of expectedCriterionIds) {
    if (!seen.has(id)) issues.push(`acceptanceCriteria: missing acceptance criterion ${JSON.stringify(id)}`);
  }
  return coverage;
}

function readLocation(
  item: Record<string, unknown>,
  field: string,
  issues: string[],
): {path: string | null; startLine: number | null; endLine: number | null} | undefined {
  const before = issues.length;
  const foundPath = readNullablePath(item, `${field}.path`, issues);
  const startLine = readNullableLine(item, "startLine", `${field}.startLine`, issues);
  const endLine = readNullableLine(item, "endLine", `${field}.endLine`, issues);
  if (issues.length !== before || foundPath === undefined || startLine === undefined || endLine === undefined) return undefined;
  if (foundPath === null && (startLine !== null || endLine !== null)) {
    issues.push(`${field}: a line location requires a repository-relative path`);
  }
  if (endLine !== null && startLine === null) issues.push(`${field}.endLine: requires startLine`);
  if (startLine !== null && endLine !== null && endLine < startLine) issues.push(`${field}.endLine: must not precede startLine`);
  if (issues.length !== before) return undefined;
  return {path: foundPath, startLine, endLine};
}

function readNullablePath(record: Record<string, unknown>, field: string, issues: string[]): string | null | undefined {
  if (!Object.hasOwn(record, "path")) {
    issues.push(`${field}: required`);
    return undefined;
  }
  const value = record.path;
  if (value === null) return null;
  if (typeof value !== "string") {
    issues.push(`${field}: must be a repository-relative path or null`);
    return undefined;
  }
  return repositoryRelativePath(value, field, issues);
}

function repositoryRelativePath(value: string, field: string, issues: string[]): string | undefined {
  const trimmed = value.trim();
  const drive = /^[A-Za-z]:[\\/]/.test(trimmed);
  const unsafe = /[\u0000-\u001F\u007F`]/.test(trimmed) || trimmed.includes("\\") || path.isAbsolute(trimmed) || drive || trimmed.split("/").includes("..");
  const relative = trimmed.replace(/^\.\//, "");
  if (!trimmed || unsafe || !relative || relative === "." || relative.split("/").some(part => part === "" || part === ".")) {
    issues.push(`${field}: must be a repository-relative path or null`);
    return undefined;
  }
  return relative;
}

function readNullableLine(record: Record<string, unknown>, key: string, field: string, issues: string[]): number | null | undefined {
  if (!Object.hasOwn(record, key)) {
    issues.push(`${field}: required`);
    return undefined;
  }
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_LINE) {
    issues.push(`${field}: must be a line number from 1 to ${MAX_LINE}, or null`);
    return undefined;
  }
  return value;
}

function readVerdict(record: Record<string, unknown>, issues: string[]): ReviewVerdict | undefined {
  if (!Object.hasOwn(record, "verdict")) {
    issues.push("verdict: required");
    return undefined;
  }
  if (!isVerdict(record.verdict)) {
    issues.push(`verdict: must be ${REVIEW_VERDICTS.join(", ")}`);
    return undefined;
  }
  return record.verdict;
}

function readSeverity(record: Record<string, unknown>, field: string, issues: string[]): FindingSeverity | undefined {
  if (!Object.hasOwn(record, "severity")) {
    issues.push(`${field}: required`);
    return undefined;
  }
  if (!isSeverity(record.severity)) {
    issues.push(`${field}: must be ${FINDING_SEVERITIES.join(", ")}`);
    return undefined;
  }
  return record.severity;
}

function readStatus(record: Record<string, unknown>, field: string, issues: string[]): CriterionStatus | undefined {
  if (!Object.hasOwn(record, "status")) {
    issues.push(`${field}: required`);
    return undefined;
  }
  if (!isStatus(record.status)) {
    issues.push(`${field}: must be ${CRITERION_STATUSES.join(", ")}`);
    return undefined;
  }
  return record.status;
}

function readCriterionRefs(
  record: Record<string, unknown>,
  field: string,
  expectedCriterionIds: readonly string[],
  issues: string[],
): string[] | undefined {
  if (!Object.hasOwn(record, "acceptanceCriteria")) {
    issues.push(`${field}: required`);
    return undefined;
  }
  if (!Array.isArray(record.acceptanceCriteria)) {
    issues.push(`${field}: must be an array of acceptance-criterion ids`);
    return undefined;
  }
  const expected = new Set(expectedCriterionIds);
  const ids: string[] = [];
  const seen = new Set<string>();
  let valid = true;
  for (const [index, value] of record.acceptanceCriteria.entries()) {
    const parsed = identifier(value, `${field}[${index}]`, issues);
    if (!parsed) {
      valid = false;
      continue;
    }
    if (seen.has(parsed)) issues.push(`${field}[${index}]: duplicate identifier ${JSON.stringify(parsed)}`);
    seen.add(parsed);
    if (!expected.has(parsed)) issues.push(`${field}[${index}]: unknown acceptance criterion ${JSON.stringify(parsed)}`);
    ids.push(parsed);
  }
  return valid && !ids.some(id => !expected.has(id)) && new Set(ids).size === ids.length ? ids : undefined;
}

function readStringList(record: Record<string, unknown>, key: string, issues: string[]): string[] {
  if (!Object.hasOwn(record, key)) {
    issues.push(`${key}: required`);
    return [];
  }
  return stringList(record[key], key, issues);
}

function readText(record: Record<string, unknown>, key: string, issues: string[], field = key): string | undefined {
  if (!Object.hasOwn(record, key)) {
    issues.push(`${field}: required`);
    return undefined;
  }
  return nonEmptyString(record[key], field, issues);
}

function readIdentifier(record: Record<string, unknown>, key: string, field: string, issues: string[]): string | undefined {
  if (!Object.hasOwn(record, key)) {
    issues.push(`${field}: required`);
    return undefined;
  }
  return identifier(record[key], field, issues);
}

function stringList(value: unknown, field: string, issues: string[]): string[] {
  if (!Array.isArray(value)) {
    issues.push(`${field}: must be an array of non-empty strings`);
    return [];
  }
  const items: string[] = [];
  for (const [index, item] of value.entries()) {
    const parsed = nonEmptyString(item, `${field}[${index}]`, issues);
    if (parsed) items.push(parsed);
  }
  return items;
}

function nonEmptyString(value: unknown, field: string, issues: string[]): string | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    issues.push(`${field}: must be a non-empty string`);
    return undefined;
  }
  return value.trim();
}

function identifier(value: unknown, field: string, issues: string[]): string | undefined {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    const rendered = typeof value === "string" ? JSON.stringify(value) : formatValue(value);
    issues.push(`${field}: invalid identifier ${rendered}. Use a letter followed by up to 63 letters, numbers, hyphens, or underscores.`);
    return undefined;
  }
  return value;
}

function renderFindings(findings: readonly ReviewFinding[]): string {
  if (findings.length === 0) return "- None";
  return FINDING_SEVERITIES.flatMap(severity => {
    const group = findings.filter(finding => finding.severity === severity);
    if (group.length === 0) return [];
    return [subsection(severity, group.map(renderFinding).join("\n\n"))];
  }).join("\n\n");
}

function renderFinding(finding: ReviewFinding): string {
  const related = finding.acceptanceCriteria.length === 0 ? "None" : finding.acceptanceCriteria.join(", ");
  return [
    `### ${finding.id}`,
    "",
    `Location: ${locationText(finding)}`,
    "",
    literalText(finding.explanation),
    "",
    prefixed("Suggested fix:", literalText(finding.suggestedFix)),
    "",
    `Related acceptance criteria: ${related}`,
  ].join("\n");
}

function locationText(finding: ReviewFinding): string {
  if (!finding.path) return "repository-wide";
  const place = inlineCode(finding.path);
  if (finding.startLine === null) return place;
  if (finding.endLine === null || finding.endLine === finding.startLine) return `${place} line ${finding.startLine}`;
  return `${place} lines ${finding.startLine}-${finding.endLine}`;
}

function renderCoverage(coverage: readonly ReviewCriterion[]): string {
  if (coverage.length === 0) return "No structured acceptance criteria were supplied. None were invented.";
  return coverage.map(criterion => [
    `## ${criterion.id}`,
    "",
    `Status: ${criterion.status}`,
    "",
    literalText(criterion.evidence),
  ].join("\n")).join("\n\n");
}

function isBlocking(severity: FindingSeverity): boolean {
  return BLOCKING_SEVERITIES.some(blocking => blocking === severity);
}

function isVerdict(value: unknown): value is ReviewVerdict {
  return REVIEW_VERDICTS.some(verdict => verdict === value);
}

function isSeverity(value: unknown): value is FindingSeverity {
  return FINDING_SEVERITIES.some(severity => severity === value);
}

function isStatus(value: unknown): value is CriterionStatus {
  return CRITERION_STATUSES.some(status => status === value);
}

function rejectUnknown(record: Record<string, unknown>, allowed: readonly string[], field: string, issues: string[]): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) issues.push(`${field ? `${field}.` : ""}${key}: unexpected field`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) return JSON.stringify(value);
  return Array.isArray(value) ? "an array" : "an object";
}
