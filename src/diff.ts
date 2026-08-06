import { createPatch } from "diff";

/**
 * Render a clean unified diff between two text contents.
 *
 * Uses stable project-relative paths in the diff header so that the
 * agent sees consistent paths regardless of the machine.
 *
 * @param relPath - Stable project-relative path (forward slashes).
 * @param oldContent - Previous content, or null for a new file.
 * @param newContent - New content, or null for a deleted file.
 * @returns Unified diff string, or null if there is no change.
 */
export function renderDiff(
  relPath: string,
  oldContent: string | null,
  newContent: string | null,
): string | null {
  // No change
  if (oldContent === newContent) return null;

  // New file
  if (oldContent === null && newContent !== null) {
    return createPatch(relPath, "", newContent, "/dev/null", `b/${relPath}`, {
      context: 3,
    });
  }

  // Deleted file
  if (newContent === null && oldContent !== null) {
    return createPatch(relPath, oldContent, "", `a/${relPath}`, "/dev/null", {
      context: 3,
    });
  }

  // Modified file
  if (oldContent !== null && newContent !== null) {
    return createPatch(relPath, oldContent, newContent, `a/${relPath}`, `b/${relPath}`, {
      context: 3,
    });
  }

  return null;
}

/**
 * Render a combined diff for multiple file changes.
 * Each file's diff is separated by a clear header.
 */
export interface FileChange {
  relPath: string;
  oldContent: string | null;
  newContent: string | null;
  kind?: "text" | "binary";
  event?: "add" | "change" | "unlink";
  size?: number | null;
}

export function renderBatchDiff(changes: FileChange[]): string {
  const parts: string[] = [];
  for (const change of changes) {
    if (change.kind === "binary") continue;
    const diff = renderDiff(change.relPath, change.oldContent, change.newContent);
    if (diff) parts.push(diff);
  }
  return parts.join("\n");
}

/**
 * Format a diff payload as a message suitable for sending to the agent.
 */
export function formatDiffMessage(changes: FileChange[]): string {
  const sections: string[] = [];
  const diff = renderBatchDiff(changes);
  if (diff.trim()) sections.push(diff);

  const binaryEvents = changes
    .filter((change) => change.kind === "binary")
    .map((change) => {
      const verb =
        change.event === "unlink" ? "deleted" : change.event === "change" ? "changed" : "added";
      const size =
        change.size === null || change.size === undefined ? "" : ` (${change.size} bytes)`;
      return `- Binary file ${verb}: ${change.relPath}${size}`;
    });
  if (binaryEvents.length > 0) sections.push(`Binary file events:\n${binaryEvents.join("\n")}`);
  if (sections.length === 0) return "";

  const fileCount = changes.length;
  const fileList = changes.map((change) => change.relPath).join(", ");
  return `The following ${fileCount} file${fileCount > 1 ? "s" : ""} changed: ${fileList}\n\n${sections.join("\n\n")}`;
}
