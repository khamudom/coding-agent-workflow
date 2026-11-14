# Evaluating a run

A completed demo does not prove that the workflow is reliable. Compare fixed tasks, keep the specification and acceptance checks unchanged, and report failures along with successes.

## What to record

| Result | Where to get it |
|---|---|
| Task accepted by a human | The diff, acceptance criteria, and your review |
| Verification result | `caw verify` logs and `run.json` |
| Elapsed time | Timestamps in the run event log |
| Rework | Another run, or manual edits after a failed attempt |
| Review quality | Reviewer findings that you confirm are real |
| Provider cost | The provider's own usage data, if you record it separately |

`caw metrics` counts stages this tool has recorded. It does not measure model quality, cost, or productivity.

## A fair comparison

- Start each attempt from the same commit and specification.
- Compare the workflow with using Codex or Claude directly when that comparison is practical.
- Include a task with incomplete requirements. The planner should state assumptions instead of inventing behavior.
- Publish sanitized plans, diffs, verification output, and reviewer findings. Remove private code and logs first.
