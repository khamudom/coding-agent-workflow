import path from "node:path";
import { bullets, escapeDelimiters, inlineCode, literalText, prefixed, section, subsection } from "./markdown.js";
import { resolvePlanReference } from "./references.js";
import type { ReferenceFile, ReferenceRepo } from "./types.js";

export const PLAN_SCHEMA_VERSION = 1;

export type PlanStatus = "verified" | "assumed";
export type RiskCategory = "security" | "accessibility" | "rollback" | "other";

export interface PlanObservation {
  path: string;
  finding: string;
  status: PlanStatus;
}

export interface PlanStep {
  id: string;
  task: string;
  acceptanceCriteria: string[];
}

export interface PlanCriterion {
  id: string;
  requirement: string;
}

export interface PlanRisk {
  category: RiskCategory;
  description: string;
  mitigation: string;
}

export interface PlanReferenceFile {
  repository: string;
  path: string;
}

export interface EngineeringPlan {
  schemaVersion: 1;
  goal: string;
  scope: {included: string[]; excluded: string[]};
  observations: PlanObservation[];
  assumptions: string[];
  unansweredQuestions: string[];
  implementationSteps: PlanStep[];
  acceptanceCriteria: PlanCriterion[];
  verification: {commands: string[][]; manualChecks: string[]};
  risks: PlanRisk[];
  referenceFiles: PlanReferenceFile[];
}

export interface ValidatedPlan {
  plan: EngineeringPlan;
  referenceFiles: ReferenceFile[];
}

const REQUIRED_RISKS = ["security", "accessibility", "rollback"] as const;
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function text(description: string): Record<string, unknown> {
  return {type: "string", description};
}

const commandSchema: Record<string, unknown> = {
  type: "array",
  description: "One suggested command in argv form, for example [\"npm\", \"test\"]. caw does not run it and does not change project verification settings.",
  items: {type: "string", description: "One argument. Blank arguments are rejected locally."},
};

export const PLAN_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  description: "Version 1 engineering plan. Matching this schema does not make the statements true.",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "goal",
    "scope",
    "observations",
    "assumptions",
    "unansweredQuestions",
    "implementationSteps",
    "acceptanceCriteria",
    "verification",
    "risks",
    "referenceFiles",
  ],
  properties: {
    schemaVersion: {type: "integer", enum: [PLAN_SCHEMA_VERSION], description: "Plan contract version. Only 1 is accepted."},
    goal: text("What the change accomplishes."),
    scope: {
      type: "object",
      additionalProperties: false,
      required: ["included", "excluded"],
      properties: {
        included: {type: "array", items: text("Work this change includes."), description: "Included work. At least one item is required."},
        excluded: {type: "array", items: text("Work this change deliberately excludes.")},
      },
    },
    observations: {
      type: "array",
      description: "Repository observations. status is verified or assumed. A verified label is a claim, not proof.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "finding", "status"],
        properties: {
          path: text("Repository-relative path this finding is about. Use \".\" for the repository root."),
          finding: text("What was observed or assumed."),
          status: {type: "string", enum: ["verified", "assumed"]},
        },
      },
    },
    assumptions: {type: "array", items: text("An assumption the plan depends on.")},
    unansweredQuestions: {type: "array", items: text("A question the plan does not answer.")},
    implementationSteps: {
      type: "array",
      description: "Ordered implementation steps. Array order is the sequence. At least one step is required.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "task", "acceptanceCriteria"],
        properties: {
          id: text("Stable identifier: a letter, then letters, numbers, hyphens, or underscores."),
          task: text("The actionable change for this step."),
          acceptanceCriteria: {
            type: "array",
            items: text("Id of an acceptance criterion this step satisfies."),
            description: "Ids from acceptanceCriteria. Each step names at least one.",
          },
        },
      },
    },
    acceptanceCriteria: {
      type: "array",
      description: "Testable requirements. At least one is required.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "requirement"],
        properties: {
          id: text("Stable identifier, unique among acceptance criteria."),
          requirement: text("The testable requirement."),
        },
      },
    },
    verification: {
      type: "object",
      additionalProperties: false,
      required: ["commands", "manualChecks"],
      properties: {
        commands: {type: "array", items: commandSchema, description: "Suggested argv commands. Recommendations only."},
        manualChecks: {type: "array", items: text("A check a person performs.")},
      },
    },
    risks: {
      type: "array",
      description: "Include at least one security, accessibility, and rollback consideration.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["category", "description", "mitigation"],
        properties: {
          category: {type: "string", enum: ["security", "accessibility", "rollback", "other"]},
          description: text("What can go wrong."),
          mitigation: text("How the plan limits that risk."),
        },
      },
    },
    referenceFiles: {
      type: "array",
      description: "Files inspected in the provided reference repositories. Empty when no reference repository was given.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["repository", "path"],
        properties: {
          repository: text("Absolute path of one provided reference repository, copied exactly."),
          path: text("Repository-relative path of a file that exists in that repository."),
        },
      },
    },
  },
};

export class PlanValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(issues.map(issue => `- ${issue}`).join("\n"));
    this.name = "PlanValidationError";
    this.issues = issues;
  }
}

export function validatePlan(input: unknown, references: readonly ReferenceRepo[] = []): ValidatedPlan {
  if (!isRecord(input)) throw new PlanValidationError(["plan: must be a JSON object"]);
  if (Object.hasOwn(input, "schemaVersion") && input.schemaVersion !== PLAN_SCHEMA_VERSION) {
    throw new PlanValidationError([`schemaVersion: unsupported version ${formatValue(input.schemaVersion)}; expected ${PLAN_SCHEMA_VERSION}`]);
  }

  const issues: string[] = [];
  rejectUnknown(input, [
    "schemaVersion",
    "goal",
    "scope",
    "observations",
    "assumptions",
    "unansweredQuestions",
    "implementationSteps",
    "acceptanceCriteria",
    "verification",
    "risks",
    "referenceFiles",
  ], "", issues);

  if (!Object.hasOwn(input, "schemaVersion")) issues.push("schemaVersion: required");
  const goal = readText(input, "goal", issues) ?? "";
  const scope = parseScope(input.scope, Object.hasOwn(input, "scope"), issues);
  const observations = parseObservations(input.observations, Object.hasOwn(input, "observations"), issues);
  const assumptions = readStringList(input, "assumptions", issues);
  const unansweredQuestions = readStringList(input, "unansweredQuestions", issues);
  const implementationSteps = parseSteps(input.implementationSteps, Object.hasOwn(input, "implementationSteps"), issues);
  const acceptanceCriteria = parseCriteria(input.acceptanceCriteria, Object.hasOwn(input, "acceptanceCriteria"), issues);
  const verification = parseVerification(input.verification, Object.hasOwn(input, "verification"), issues);
  const risks = parseRisks(input.risks, Object.hasOwn(input, "risks"), issues);
  const resolved = parseReferenceFiles(input.referenceFiles, Object.hasOwn(input, "referenceFiles"), references, issues);
  linkCriteria(implementationSteps, acceptanceCriteria, issues);

  if (issues.length > 0) throw new PlanValidationError(issues);
  return {
    plan: {
      schemaVersion: PLAN_SCHEMA_VERSION,
      goal,
      scope,
      observations,
      assumptions,
      unansweredQuestions,
      implementationSteps,
      acceptanceCriteria,
      verification,
      risks,
      referenceFiles: resolved.map(file => ({repository: file.repository, path: file.path})),
    },
    referenceFiles: resolved,
  };
}

export function canonicalPlanJson(plan: EngineeringPlan): string {
  return `${JSON.stringify(plan, null, 2)}\n`;
}

export function renderPlan(plan: EngineeringPlan): string {
  return [
    section("Goal", literalText(plan.goal)),
    section("Scope and non-goals", [
      subsection("Included", bullets(plan.scope.included)),
      subsection("Excluded", bullets(plan.scope.excluded)),
    ].join("\n\n")),
    section("Repository observations", renderObservations(plan.observations)),
    section("Assumptions / unanswered questions", [
      subsection("Assumptions", bullets(plan.assumptions)),
      subsection("Unanswered questions", bullets(plan.unansweredQuestions)),
    ].join("\n\n")),
    section("Implementation steps", renderSteps(plan.implementationSteps)),
    section("Acceptance criteria", renderCriteria(plan.acceptanceCriteria)),
    section("Verification approach", [
      subsection("Commands", commandBullets(plan.verification.commands)),
      subsection("Manual checks", bullets(plan.verification.manualChecks)),
    ].join("\n\n")),
    section("Risks, security, accessibility, and rollback", renderRisks(plan.risks)),
    section("Reference files", renderReferences(plan.referenceFiles)),
  ].join("\n\n") + "\n";
}

function parseScope(value: unknown, present: boolean, issues: string[]): EngineeringPlan["scope"] {
  if (!present) {
    issues.push("scope: required");
    return {included: [], excluded: []};
  }
  if (!isRecord(value)) {
    issues.push("scope: must be an object with included and excluded arrays");
    return {included: [], excluded: []};
  }
  rejectUnknown(value, ["included", "excluded"], "scope", issues);
  const included = readNestedStringList(value, "included", "scope.included", issues);
  const excluded = readNestedStringList(value, "excluded", "scope.excluded", issues);
  if (Array.isArray(value.included) && value.included.length === 0) issues.push("scope.included: at least one included item is required");
  return {included, excluded};
}

function parseObservations(value: unknown, present: boolean, issues: string[]): PlanObservation[] {
  if (!present) {
    issues.push("observations: required");
    return [];
  }
  if (!Array.isArray(value)) {
    issues.push("observations: must be an array");
    return [];
  }
  const observations: PlanObservation[] = [];
  for (const [index, item] of value.entries()) {
    const field = `observations[${index}]`;
    if (!isRecord(item)) {
      issues.push(`${field}: must be an object`);
      continue;
    }
    rejectUnknown(item, ["path", "finding", "status"], field, issues);
    const observedPath = Object.hasOwn(item, "path") ? repositoryRelativePath(item.path, `${field}.path`, issues, true) : undefined;
    if (!Object.hasOwn(item, "path")) issues.push(`${field}.path: required`);
    const finding = readText(item, "finding", issues, `${field}.finding`);
    const status = item.status === "verified" || item.status === "assumed" ? item.status : undefined;
    if (!Object.hasOwn(item, "status")) issues.push(`${field}.status: required`);
    else if (!status) issues.push(`${field}.status: must be verified or assumed`);
    if (!observedPath || !finding || !status) continue;
    observations.push({path: observedPath, finding, status});
  }
  return observations;
}

function parseSteps(value: unknown, present: boolean, issues: string[]): PlanStep[] {
  if (!present) {
    issues.push("implementationSteps: required");
    return [];
  }
  if (!Array.isArray(value)) {
    issues.push("implementationSteps: must be an array");
    return [];
  }
  if (value.length === 0) issues.push("implementationSteps: at least one implementation step is required");
  const steps: PlanStep[] = [];
  for (const [index, item] of value.entries()) {
    const field = `implementationSteps[${index}]`;
    if (!isRecord(item)) {
      issues.push(`${field}: must be an object`);
      continue;
    }
    rejectUnknown(item, ["id", "task", "acceptanceCriteria"], field, issues);
    const id = readIdentifier(item, "id", `${field}.id`, issues);
    const task = readText(item, "task", issues, `${field}.task`);
    let acceptanceCriteria: string[] = [];
    if (!Object.hasOwn(item, "acceptanceCriteria")) issues.push(`${field}.acceptanceCriteria: required`);
    else if (!Array.isArray(item.acceptanceCriteria)) issues.push(`${field}.acceptanceCriteria: must be an array of acceptance-criterion ids`);
    else {
      if (item.acceptanceCriteria.length === 0) issues.push(`${field}.acceptanceCriteria: must reference at least one acceptance criterion`);
      acceptanceCriteria = item.acceptanceCriteria.flatMap((criterionId, refIndex) => {
        const parsed = identifier(criterionId, `${field}.acceptanceCriteria[${refIndex}]`, issues);
        return parsed ? [parsed] : [];
      });
    }
    if (!id || !task) continue;
    steps.push({id, task, acceptanceCriteria});
  }
  return steps;
}

function parseCriteria(value: unknown, present: boolean, issues: string[]): PlanCriterion[] {
  if (!present) {
    issues.push("acceptanceCriteria: required");
    return [];
  }
  if (!Array.isArray(value)) {
    issues.push("acceptanceCriteria: must be an array");
    return [];
  }
  if (value.length === 0) issues.push("acceptanceCriteria: at least one acceptance criterion is required");
  const criteria: PlanCriterion[] = [];
  for (const [index, item] of value.entries()) {
    const field = `acceptanceCriteria[${index}]`;
    if (!isRecord(item)) {
      issues.push(`${field}: must be an object`);
      continue;
    }
    rejectUnknown(item, ["id", "requirement"], field, issues);
    const id = readIdentifier(item, "id", `${field}.id`, issues);
    const requirement = readText(item, "requirement", issues, `${field}.requirement`);
    if (!id || !requirement) continue;
    criteria.push({id, requirement});
  }
  return criteria;
}

function parseVerification(value: unknown, present: boolean, issues: string[]): EngineeringPlan["verification"] {
  if (!present) {
    issues.push("verification: required");
    return {commands: [], manualChecks: []};
  }
  if (!isRecord(value)) {
    issues.push("verification: must be an object with commands and manualChecks");
    return {commands: [], manualChecks: []};
  }
  rejectUnknown(value, ["commands", "manualChecks"], "verification", issues);
  return {
    commands: parseCommands(value.commands, Object.hasOwn(value, "commands"), issues),
    manualChecks: readNestedStringList(value, "manualChecks", "verification.manualChecks", issues),
  };
}

function parseCommands(value: unknown, present: boolean, issues: string[]): string[][] {
  if (!present) {
    issues.push("verification.commands: required");
    return [];
  }
  if (!Array.isArray(value)) {
    issues.push("verification.commands: must be an array of argv arrays, for example [[\"npm\", \"test\"]]");
    return [];
  }
  const commands: string[][] = [];
  for (const [index, command] of value.entries()) {
    const args = Array.isArray(command) ? command.filter((part): part is string => typeof part === "string") : [];
    if (!Array.isArray(command) || args.length !== command.length || args.length === 0 || args.some(part => part.trim() === "")) {
      issues.push(`verification.commands[${index}]: must be a non-empty argv array of non-empty strings`);
      continue;
    }
    commands.push(args);
  }
  return commands;
}

function parseRisks(value: unknown, present: boolean, issues: string[]): PlanRisk[] {
  if (!present) {
    issues.push("risks: required");
    return [];
  }
  if (!Array.isArray(value)) {
    issues.push("risks: must be an array");
    return [];
  }
  const risks: PlanRisk[] = [];
  for (const [index, item] of value.entries()) {
    const field = `risks[${index}]`;
    if (!isRecord(item)) {
      issues.push(`${field}: must be an object`);
      continue;
    }
    rejectUnknown(item, ["category", "description", "mitigation"], field, issues);
    if (!Object.hasOwn(item, "category")) issues.push(`${field}.category: required`);
    const category = isRiskCategory(item.category) ? item.category : undefined;
    if (Object.hasOwn(item, "category") && !category) issues.push(`${field}.category: must be security, accessibility, rollback, or other`);
    const description = readText(item, "description", issues, `${field}.description`);
    const mitigation = readText(item, "mitigation", issues, `${field}.mitigation`);
    if (!category || !description || !mitigation) continue;
    risks.push({category, description, mitigation});
  }
  for (const category of REQUIRED_RISKS) {
    if (!risks.some(risk => risk.category === category)) issues.push(`risks: missing ${category} consideration`);
  }
  return risks;
}

function parseReferenceFiles(value: unknown, present: boolean, references: readonly ReferenceRepo[], issues: string[]): ReferenceFile[] {
  if (!present) {
    issues.push("referenceFiles: required");
    return [];
  }
  if (!Array.isArray(value)) {
    issues.push("referenceFiles: must be an array");
    return [];
  }
  if (references.length === 0 && value.length > 0) {
    issues.push("referenceFiles: no reference repository was provided");
    return [];
  }
  if (references.length > 0 && value.length === 0) {
    issues.push("referenceFiles: list at least one existing file that was inspected");
    return [];
  }
  const resolved: ReferenceFile[] = [];
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    const field = `referenceFiles[${index}]`;
    if (!isRecord(item)) {
      issues.push(`${field}: must be an object with repository and path`);
      continue;
    }
    rejectUnknown(item, ["repository", "path"], field, issues);
    const repository = typeof item.repository === "string" ? item.repository : undefined;
    const filePath = typeof item.path === "string" ? item.path : undefined;
    if (!Object.hasOwn(item, "repository") || repository === undefined || repository.trim() === "") {
      issues.push(`${field}.repository: must be the absolute path of a provided reference repository`);
    }
    if (!Object.hasOwn(item, "path") || filePath === undefined || filePath.trim() === "") {
      issues.push(`${field}.path: must be a repository-relative path`);
    }
    if (!repository || repository.trim() === "" || !filePath || filePath.trim() === "") continue;
    try {
      const file = resolvePlanReference({repository, path: filePath}, references);
      const key = `${file.repository}\n${file.path}`;
      if (seen.has(key)) issues.push(`${field}: duplicate reference file ${file.path}`);
      seen.add(key);
      resolved.push(file);
    } catch (error) {
      issues.push(`${field}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return resolved;
}

function linkCriteria(steps: readonly PlanStep[], criteria: readonly PlanCriterion[], issues: string[]): void {
  const criterionIds = new Set<string>();
  criteria.forEach((criterion, index) => {
    if (criterionIds.has(criterion.id)) issues.push(`acceptanceCriteria[${index}].id: duplicate identifier ${JSON.stringify(criterion.id)}`);
    criterionIds.add(criterion.id);
  });
  const stepIds = new Set<string>();
  steps.forEach((step, index) => {
    if (stepIds.has(step.id)) issues.push(`implementationSteps[${index}].id: duplicate identifier ${JSON.stringify(step.id)}`);
    stepIds.add(step.id);
    const seen = new Set<string>();
    step.acceptanceCriteria.forEach((criterionId, refIndex) => {
      if (seen.has(criterionId)) issues.push(`implementationSteps[${index}].acceptanceCriteria[${refIndex}]: duplicate identifier ${JSON.stringify(criterionId)}`);
      seen.add(criterionId);
      if (!criterionIds.has(criterionId)) issues.push(`implementationSteps[${index}].acceptanceCriteria[${refIndex}]: unknown acceptance criterion ${JSON.stringify(criterionId)}`);
    });
  });
}

function readStringList(record: Record<string, unknown>, key: string, issues: string[]): string[] {
  if (!Object.hasOwn(record, key)) {
    issues.push(`${key}: required`);
    return [];
  }
  return stringList(record[key], key, issues);
}

function readNestedStringList(record: Record<string, unknown>, key: string, field: string, issues: string[]): string[] {
  if (!Object.hasOwn(record, key)) {
    issues.push(`${field}: required`);
    return [];
  }
  return stringList(record[key], field, issues);
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

function repositoryRelativePath(value: unknown, field: string, issues: string[], allowRoot = false): string | undefined {
  if (typeof value !== "string") {
    issues.push(`${field}: must be a repository-relative path`);
    return undefined;
  }
  const trimmed = value.trim();
  const drive = /^[A-Za-z]:[\\/]/.test(trimmed);
  if (!trimmed || path.isAbsolute(trimmed) || drive || trimmed.includes("\\") || trimmed.split("/").includes("..")) {
    issues.push(`${field}: must be a repository-relative path`);
    return undefined;
  }
  if (allowRoot && trimmed === ".") return ".";
  const relative = trimmed.replace(/^\.\//, "");
  if (!relative || relative.split("/").some(part => part === "" || part === ".")) {
    issues.push(`${field}: must be a repository-relative path`);
    return undefined;
  }
  return relative;
}

function isRiskCategory(value: unknown): value is RiskCategory {
  return value === "security" || value === "accessibility" || value === "rollback" || value === "other";
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

function commandBullets(commands: readonly string[][]): string {
  if (commands.length === 0) return "- None";
  return commands.map(command => `- ${escapeDelimiters(JSON.stringify(command))}`).join("\n");
}

function renderObservations(observations: readonly PlanObservation[]): string {
  if (observations.length === 0) return "- None";
  return observations.map(observation => {
    const finding = literalText(observation.finding).split("\n");
    return prefixed(`- ${inlineCode(observation.path)} (${observation.status}):`, finding.join("\n"));
  }).join("\n");
}

function renderSteps(steps: readonly PlanStep[]): string {
  return steps.map(step => `## ${step.id}\n\n${literalText(step.task)}\n\nAcceptance criteria: ${step.acceptanceCriteria.join(", ")}`).join("\n\n");
}

function renderCriteria(criteria: readonly PlanCriterion[]): string {
  return criteria.map(criterion => `## ${criterion.id}\n\n${literalText(criterion.requirement)}`).join("\n\n");
}

function renderRisks(risks: readonly PlanRisk[]): string {
  return risks.map(risk => `## ${risk.category}\n\n${literalText(risk.description)}\n\n${prefixed("Mitigation:", literalText(risk.mitigation))}`).join("\n\n");
}

function renderReferences(files: readonly PlanReferenceFile[]): string {
  if (files.length === 0) return "- None";
  return files.map(file => `- ${inlineCode(file.repository)} ${inlineCode(file.path)}`).join("\n");
}
