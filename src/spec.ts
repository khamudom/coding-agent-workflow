const OBJECTIVE = /^(objective|goal|problem statement)$/;
const SCOPE = /^(scope|in scope|scope and non-goals)$/;
const ACCEPTANCE = /^(acceptance criteria|acceptance criterion|acceptance|success criteria|done when)$/;

const PLACEHOLDER_LINES = new Set([
  "tbd",
  "todo",
  "fixme",
  "xxx",
  "tk",
  "n/a",
  "na",
  "none",
  "placeholder",
  "lorem ipsum",
  "it works",
  "works as expected",
  "functions correctly",
  "looks good",
  "done",
  "tests pass",
  "all tests pass",
  "meets requirements",
  "as expected",
  "describe the user problem and measurable outcome",
  "what should change, and what should not",
  "define observable user-facing behavior",
  "define error and loading behavior as applicable",
  "tests cover core behavior and regressions",
  "describe expected tests or manual checks",
]);

const INSTRUCTIONAL = /^(?:describe|define|explain|specify)\b.{0,120}\b(?:here|outcome|behavior|behaviour|criteria|criterion|applicable|details|text|section)$/;

interface Section {
  title: string;
  level: number;
  lines: string[];
}

interface SectionCopy {
  label: string;
  missing: string;
  empty: string;
  placeholder: (quoted: string) => string;
}

export function validateSpecification(markdown: string): string[] {
  const sections = parseSections(markdown);
  const example = '"- [ ] Escape closes Dialog."';
  return [
    ...sectionIssues(sectionBody(sections, OBJECTIVE), {
      label: "Objective",
      missing: 'Add a heading such as "## Objective", "## Goal", or "## Problem statement" and describe the user problem and measurable outcome.',
      empty: "Describe the user problem and measurable outcome.",
      placeholder: quoted => `Objective: placeholder content "${quoted}". Replace it with the user problem and measurable outcome.`,
    }),
    ...sectionIssues(sectionBody(sections, SCOPE), {
      label: "Scope",
      missing: 'Add a heading such as "## Scope", "## In scope", or "## Scope and non-goals" and state what should change and what should not.',
      empty: "State what should change and what should not.",
      placeholder: quoted => `Scope: placeholder content "${quoted}". State what should change and what should not.`,
    }),
    ...sectionIssues(sectionBody(sections, ACCEPTANCE), {
      label: "Acceptance criteria",
      missing: `Add a heading such as "## Acceptance criteria" and at least one concrete, testable criterion, for example ${example}`,
      empty: `Add at least one concrete, testable criterion, for example ${example}`,
      placeholder: quoted => `Acceptance criteria: placeholder item "${quoted}". Replace it with a concrete, testable outcome, for example ${example}`,
    }),
  ];
}

function sectionIssues(body: string[] | null, copy: SectionCopy): string[] {
  if (body === null) return [`${copy.label}: section is missing. ${copy.missing}`];
  const lines = contentLines(body);
  if (lines.length === 0) return [`${copy.label}: section is empty. ${copy.empty}`];
  return lines.filter(isPlaceholder).map(line => copy.placeholder(quote(line)));
}

function parseSections(markdown: string): Section[] {
  const sections: Section[] = [];
  let current: Section | undefined;
  let fence: {char: string; size: number} | undefined;
  const comment = {open: false};
  for (const raw of markdown.split(/\r?\n/)) {
    if (fence) {
      const close = /^(?: {0,3})(`{3,}|~{3,})\s*$/.exec(raw);
      const marker = close?.[1];
      if (marker && marker[0] === fence.char && marker.length >= fence.size) fence = undefined;
      continue;
    }
    const opened = /^(?: {0,3})(`{3,}|~{3,})/.exec(raw)?.[1];
    if (opened?.[0]) {
      fence = {char: opened[0], size: opened.length};
      continue;
    }
    const visible = visibleText(raw, comment);
    const heading = /^(?: {0,3})(#{1,6})\s+(.+?)\s*#*\s*$/.exec(visible);
    const marks = heading?.[1];
    const title = heading?.[2]?.replace(/\s+#+\s*$/, "").trim();
    if (marks && title) {
      current = {title, level: marks.length, lines: []};
      sections.push(current);
      continue;
    }
    current?.lines.push(visible);
  }
  return sections;
}

function visibleText(line: string, comment: {open: boolean}): string {
  let rest = line;
  let result = "";
  if (comment.open) {
    const close = rest.indexOf("-->");
    if (close === -1) return "";
    comment.open = false;
    rest = rest.slice(close + 3);
  }
  while (rest.length > 0) {
    const open = rest.indexOf("<!--");
    if (open === -1) return result + rest;
    result += rest.slice(0, open);
    const close = rest.indexOf("-->", open + 4);
    if (close === -1) {
      comment.open = true;
      return result;
    }
    rest = rest.slice(close + 3);
  }
  return result;
}

function sectionBody(sections: Section[], pattern: RegExp): string[] | null {
  let found = false;
  const lines: string[] = [];
  for (let index = 0; index < sections.length; index++) {
    const section = sections[index];
    if (!section || !pattern.test(normalizeTitle(section.title))) continue;
    if (nestedInMatch(sections, index, pattern)) continue;
    found = true;
    lines.push(...linesFor(sections, index));
  }
  return found ? lines : null;
}

function nestedInMatch(sections: Section[], index: number, pattern: RegExp): boolean {
  const section = sections[index];
  if (!section) return false;
  for (let previous = index - 1; previous >= 0; previous--) {
    const candidate = sections[previous];
    if (!candidate) continue;
    if (candidate.level < section.level && pattern.test(normalizeTitle(candidate.title))) return true;
    if (candidate.level <= section.level) return false;
  }
  return false;
}

function linesFor(sections: Section[], index: number): string[] {
  const section = sections[index];
  if (!section) return [];
  const lines = [...section.lines];
  for (let cursor = index + 1; cursor < sections.length; cursor++) {
    const child = sections[cursor];
    if (!child || child.level <= section.level) break;
    lines.push(...child.lines);
  }
  return lines;
}

function normalizeTitle(title: string): string {
  return title.replace(/:$/, "").trim().toLowerCase().replace(/\s+/g, " ");
}

function contentLines(lines: string[]): string[] {
  return lines.map(stripLine).filter(line => line.length > 0 && !/^(?:[-*_]\s*){3,}$/.test(line));
}

function stripLine(raw: string): string {
  return raw.trim().replace(/^(?:>\s*)+/, "").replace(/^(?:[-*+]|\d+[.)])\s+/, "").replace(/^\[[ xX]\]\s*/, "").trim();
}

// Whole-line only, so a concrete sentence that mentions "TODO" still passes.
function isPlaceholder(line: string): boolean {
  const compact = line.trim().toLowerCase().replace(/\s+/g, " ");
  if (/^(?:\.{3,}|…+|\?{3,}|x{3,})$/.test(compact)) return true;
  if (/^\[(?:todo|tbd|insert|placeholder)\b[^\]]*\]$/.test(compact)) return true;
  if (/^<[^>\n]+>$/.test(compact)) return true;
  const normalized = unwrap(compact.replace(/[.!?]+$/g, "").trim());
  if (PLACEHOLDER_LINES.has(normalized)) return true;
  if (INSTRUCTIONAL.test(normalized)) return true;
  return normalized.startsWith("lorem ipsum");
}

function unwrap(text: string): string {
  const wrapped = /^\((.*)\)$|^\[(.*)\]$|^"(.*)"$|^'(.*)'$/.exec(text);
  const inner = wrapped?.[1] ?? wrapped?.[2] ?? wrapped?.[3] ?? wrapped?.[4];
  return (inner ?? text).trim();
}

function quote(line: string): string {
  const compact = line.replace(/\s+/g, " ").trim();
  return compact.length <= 120 ? compact : `${compact.slice(0, 117)}...`;
}
