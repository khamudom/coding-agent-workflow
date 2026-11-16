const DELIMITERS = /<\s*\/?\s*(?:approved-plan|specification|reference-evidence|reference-file|reference-repositories|git-diff|untracked-files|verification-evidence)\b/gi;

export function section(title: string, body: string): string {
  return `# ${title}\n\n${body}`;
}

export function subsection(title: string, body: string): string {
  return `## ${title}\n\n${body}`;
}

export function bullets(items: readonly string[]): string {
  if (items.length === 0) return "- None";
  return items.map(item => prefixed("-", literalText(item))).join("\n");
}

export function escapeDelimiters(text: string): string {
  return text.replace(DELIMITERS, match => `<\\${match.slice(1)}`);
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function literalText(text: string): string {
  const lines = escapeDelimiters(normalizeLineEndings(text)).split("\n");
  const rendered: string[] = [];
  let fence: {marker: string; size: number} | null = null;
  for (const line of lines) {
    if (fence) {
      rendered.push(line);
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    const opened = opensFence(line);
    if (opened) {
      fence = opened;
      rendered.push(line);
      continue;
    }
    rendered.push(escapeStructuralLine(line));
  }
  if (fence) rendered.push(fence.marker.repeat(fence.size));
  return rendered.join("\n");
}

function opensFence(line: string): {marker: string; size: number} | null {
  const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
  const token = match?.[2];
  if (!token) return null;
  if (token.startsWith("`") && (match[3] ?? "").includes("`")) return null;
  const marker = token[0];
  if (!marker) return null;
  return {marker, size: token.length};
}

function closesFence(line: string, fence: {marker: string; size: number}): boolean {
  const match = /^( {0,3})(`{3,}|~{3,})\s*$/.exec(line);
  const token = match?.[2];
  return Boolean(token && token.startsWith(fence.marker) && token.length >= fence.size);
}

function escapeStructuralLine(line: string): string {
  const match = /^( {0,3}(?:> *)*)(.*)$/.exec(line);
  const prefix = match?.[1] ?? "";
  const rest = match?.[2] ?? line;
  const structural = /^#{1,6}(?:[ \t]|$)/.test(rest)
    || /^(?:=+|(?:-[ \t]*)+|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})\s*$/.test(rest)
    || rest.startsWith("<");
  return structural ? `${prefix}\\${rest}` : line;
}

export function inlineCode(text: string): string {
  const literal = literalText(text);
  if (literal.includes("`") || literal.includes("\n")) return literal;
  return `\`${literal}\``;
}

export function prefixed(prefix: string, text: string): string {
  const lines = text.split("\n");
  return [`${prefix} ${lines[0] ?? ""}`, ...lines.slice(1)].join("\n");
}
