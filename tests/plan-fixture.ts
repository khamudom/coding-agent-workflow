import type { EngineeringPlan } from "../src/plan.js";

export function validPlan(): EngineeringPlan {
  return {
    schemaVersion: 1,
    goal: "Create output.txt when the feature is implemented.",
    scope: {
      included: ["Add output.txt in the worktree"],
      excluded: ["Changing the main checkout"],
    },
    observations: [
      {path: "README.md", finding: "The repository has a README.", status: "verified"},
    ],
    assumptions: [],
    unansweredQuestions: [],
    implementationSteps: [
      {id: "create-output", task: "Create output.txt.", acceptanceCriteria: ["output-exists"]},
    ],
    acceptanceCriteria: [
      {id: "output-exists", requirement: "output.txt exists after implementation."},
    ],
    verification: {
      commands: [["npm", "test"]],
      manualChecks: ["Open output.txt and confirm it is non-empty."],
    },
    risks: [
      {category: "security", description: "No new trust boundary.", mitigation: "Do not read secrets."},
      {category: "accessibility", description: "No user interface is added.", mitigation: "No accessibility change is required."},
      {category: "rollback", description: "The worktree can be discarded.", mitigation: "Leave the main checkout untouched."},
    ],
    referenceFiles: [],
  };
}
