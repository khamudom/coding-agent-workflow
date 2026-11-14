export type Provider = "codex" | "claude";
export type Stage = "planned" | "approved" | "executed" | "execution_failed" | "verified" | "verification_failed" | "reviewed" | "review_failed";

export interface Config {
  schemaVersion: 1;
  defaultProvider: Provider;
  verify: string[][];
  executionTimeoutMinutes: number;
  maxSpecBytes: number;
}

export interface CheckResult {
  command: string[];
  exitCode: number;
  durationMs: number;
  log: string;
}
export interface ReferenceRepo {
  path: string;
  commit: string;
  dirty: boolean;
}
export interface ReferenceFile {
  repository: string;
  path: string;
  sha256: string;
}
export interface Run {
  schemaVersion: 1;
  id: string;
  specSource: string;
  specHash: string;
  provider: Provider;
  stage: Stage;
  repoRoot: string;
  baseCommit: string;
  branch: string;
  worktree?: string;
  createdAt: string;
  approvedAt?: string;
  approvedPlanHash?: string;
  approvedConfigHash?: string;
  verifiedWorktreeHash?: string;
  executedAt?: string;
  verifiedAt?: string;
  reviewedAt?: string;
  executionExitCode?: number;
  reviewProvider?: Provider;
  references?: ReferenceRepo[];
  referenceFiles?: ReferenceFile[];
  checkResults?: CheckResult[];
  eventLog: Array<{at: string; event: string; note?: string}>;
}
