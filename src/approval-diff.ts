import type {
  SessionDiffHunk,
  SessionDiffHunkLine,
  SessionDiffPreview,
} from "@letta-ai/letta-agent-sdk";

const ANSI = {
  reset: "\u001b[0m",
  cyan: "\u001b[36m",
  green: "\u001b[32m",
  red: "\u001b[31m",
  yellow: "\u001b[33m",
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isDiffLine(value: unknown): value is SessionDiffHunkLine {
  return (
    isRecord(value) &&
    (value.type === "context" || value.type === "add" || value.type === "remove") &&
    typeof value.content === "string"
  );
}

function isDiffHunk(value: unknown): value is SessionDiffHunk {
  return (
    isRecord(value) &&
    typeof value.oldStart === "number" &&
    typeof value.oldLines === "number" &&
    typeof value.newStart === "number" &&
    typeof value.newLines === "number" &&
    Array.isArray(value.lines) &&
    value.lines.every(isDiffLine)
  );
}

function isDiffPreview(value: unknown): value is SessionDiffPreview {
  if (!isRecord(value) || typeof value.fileName !== "string") return false;
  if (value.mode === "advanced") {
    return Array.isArray(value.hunks) && value.hunks.every(isDiffHunk);
  }
  return (
    (value.mode === "fallback" || value.mode === "unpreviewable") &&
    typeof value.reason === "string"
  );
}

function colorize(text: string, color: keyof Omit<typeof ANSI, "reset">, enabled: boolean): string {
  return enabled ? `${ANSI[color]}${text}${ANSI.reset}` : text;
}

function prefixedLines(line: SessionDiffHunkLine, color: boolean): string[] {
  const prefix = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
  const style = line.type === "add" ? "green" : line.type === "remove" ? "red" : null;
  return line.content.split("\n").map((content) => {
    const rendered = `${prefix}${content}`;
    return style ? colorize(rendered, style, color) : rendered;
  });
}

export function renderDiffPreview(preview: unknown, color = false): string | null {
  if (!isDiffPreview(preview)) return null;
  if (preview.mode !== "advanced") {
    return colorize(
      `${preview.fileName}: diff preview unavailable (${preview.reason})`,
      "yellow",
      color,
    );
  }

  const path = preview.fileName.replace(/^\.\//, "");
  const lines = [
    colorize(`--- a/${path}`, "cyan", color),
    colorize(`+++ b/${path}`, "cyan", color),
  ];
  for (const hunk of preview.hunks) {
    lines.push(
      colorize(
        `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
        "cyan",
        color,
      ),
    );
    for (const line of hunk.lines) lines.push(...prefixedLines(line, color));
  }
  return lines.join("\n");
}

export function renderDiffPreviews(previews: unknown[], color = false): string[] {
  return previews
    .map((preview) => renderDiffPreview(preview, color))
    .filter((value) => value !== null);
}
