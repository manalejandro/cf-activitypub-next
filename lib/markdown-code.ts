/**
 * Markdown code awareness for composers and status processing.
 *
 * `@options`, `#tag` or `:emoji:` inside a code sample are text, not mentions,
 * hashtags or emoji: the composer must not offer autocomplete there and the
 * server must not create AP tags, link them or expand bare handles.
 */

/** Single backticks that are not part of a triple fence. */
const SINGLE_BACKTICK_RE = /(?<!`)`(?!`)/g;

/**
 * Whether `position` falls inside a Markdown fenced code block or an inline
 * code span. Positions on the fence line itself count as outside so the
 * language hint keeps working.
 */
export function isInsideMarkdownCode(text: string, position: number): boolean {
  const before = text.slice(0, position);
  const fences = before.match(/^\s*```/gm)?.length ?? 0;
  if (fences % 2 === 1) return true;

  const lineStart = before.lastIndexOf("\n") + 1;
  const line = before.slice(lineStart);
  if (/^\s*```/.test(line)) return false;
  return ((line.match(SINGLE_BACKTICK_RE) ?? []).length % 2) === 1;
}

/**
 * Blank out fenced code blocks and inline code spans, preserving the string
 * length and newlines so offsets stay valid for the linkifier's index-based
 * replacements.
 */
export function maskMarkdownCode(text: string): string {
  return text.replace(/```[\s\S]*?(?:```|$)|`[^`\n]*`/g, (match) =>
    match.replace(/[^\n]/g, " ")
  );
}
