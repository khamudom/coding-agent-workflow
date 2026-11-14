import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateSpecification } from "../src/spec.js";

const examplePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../examples/dialog-component.spec.md");

const initTemplate = `# Example feature specification

## Objective
Describe the user problem and measurable outcome.

## Scope
What should change, and what should not?

## Acceptance criteria
- [ ] Define observable user-facing behavior.
- [ ] Define error and loading behavior as applicable.
- [ ] Tests cover core behavior and regressions.

## Constraints
Follow this repository's architecture and accessibility conventions.

## Verification
Describe expected tests or manual checks.
`;

test("documented dialog specification is valid", () => {
  assert.deepEqual(validateSpecification(readFileSync(examplePath, "utf8")), []);
});

test("short objective, scope, and acceptance criterion are valid", () => {
  const spec = `## Objective
Add login

## Scope
UI

## Acceptance criteria
Escape closes Dialog
`;
  assert.deepEqual(validateSpecification(spec), []);
  assert.deepEqual(validateSpecification(spec.replace("Escape closes Dialog", "- [ ] Escape closes Dialog")), []);
});

test("a concrete sentence may contain the word TODO", () => {
  const spec = `## Goal
Show the remaining TODO count on the board.

## Scope
The board header only.

## Acceptance criteria
- [ ] The board header shows the remaining TODO count.
`;
  assert.deepEqual(validateSpecification(spec), []);
});

test("missing objective, scope, and acceptance are all reported", () => {
  const issues = validateSpecification("# Notes\n\nDo the thing later.\n");
  assert.deepEqual(issues, [
    'Objective: section is missing. Add a heading such as "## Objective", "## Goal", or "## Problem statement" and describe the user problem and measurable outcome.',
    'Scope: section is missing. Add a heading such as "## Scope", "## In scope", or "## Scope and non-goals" and state what should change and what should not.',
    'Acceptance criteria: section is missing. Add a heading such as "## Acceptance criteria" and at least one concrete, testable criterion, for example "- [ ] Escape closes Dialog."',
  ]);
});

test("empty required sections are reported", () => {
  const issues = validateSpecification("## Objective\n\n## Scope\n\n## Acceptance criteria\n");
  assert.equal(issues.length, 3);
  assert.match(issues[0]!, /Objective: section is empty/);
  assert.match(issues[1]!, /Scope: section is empty/);
  assert.match(issues[2]!, /Acceptance criteria: section is empty/);
});

test("the generated example template is rejected as placeholder content", () => {
  const issues = validateSpecification(initTemplate);
  assert.equal(issues.length, 5);
  assert.match(issues[0]!, /Objective: placeholder content "Describe the user problem and measurable outcome\."/);
  assert.match(issues[1]!, /Scope: placeholder content "What should change, and what should not\?"/);
  assert.match(issues[2]!, /Define observable user-facing behavior\./);
  assert.match(issues[3]!, /Define error and loading behavior as applicable\./);
  assert.match(issues[4]!, /Tests cover core behavior and regressions\./);
  assert.doesNotMatch(issues.join("\n"), /Constraints|Verification/);
});

test("TBD and lorem ipsum sections are placeholders", () => {
  const tbd = validateSpecification(`## Objective
Ship the dialog.

## Scope
TBD

## Acceptance criteria
- [ ] Escape closes Dialog
`);
  assert.deepEqual(tbd, [
    'Scope: placeholder content "TBD". State what should change and what should not.',
  ]);
  const lorem = validateSpecification(`## Objective
lorem ipsum

## Scope
Dialog only.

## Acceptance criteria
- [ ] Escape closes Dialog
`);
  assert.match(lorem[0]!, /Objective: placeholder content "lorem ipsum"/);
});

test("instructional and vague acceptance lines are rejected", () => {
  const defined = validateSpecification(`## Objective
Ship the dialog.

## Scope
Dialog only.

## Acceptance criteria
- [ ] Define observable user-facing behavior.
`);
  assert.match(defined[0]!, /placeholder item "Define observable user-facing behavior\."/);
  assert.match(defined[0]!, /Escape closes Dialog/);
  const vague = validateSpecification(`## Objective
Ship the dialog.

## Scope
Dialog only.

## Acceptance criteria
It works.
`);
  assert.match(vague[0]!, /placeholder item "It works\."/);
  assert.match(vague[0]!, /concrete, testable outcome/);
});

test("a placeholder criterion fails even when another criterion is concrete", () => {
  const issues = validateSpecification(`## Objective
Show a confirmation after save.

## Scope
The save action only.

## Acceptance criteria
- [ ] Save persists the draft and shows a confirmation.
- [ ] TBD
`);
  assert.deepEqual(issues, [
    'Acceptance criteria: placeholder item "TBD". Replace it with a concrete, testable outcome, for example "- [ ] Escape closes Dialog."',
  ]);
});
