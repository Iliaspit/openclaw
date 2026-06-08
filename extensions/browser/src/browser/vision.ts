/** Neutralizes page-controlled MEDIA directives before feeding text back to tools. */
export function neutralizeMediaDirectives(text: string): string {
  if (!text || !/media:/i.test(text)) {
    return text;
  }
  const lines = text.split("\n");
  let changed = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const leading = line.length - line.trimStart().length;
    const rest = line.slice(leading);
    if (/^MEDIA:/i.test(rest)) {
      lines[i] = `${line.slice(0, leading)}[neutralized] ${rest}`;
      changed = true;
    }
  }
  return changed ? lines.join("\n") : text;
}
