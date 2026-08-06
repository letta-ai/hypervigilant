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
}

export function renderBatchDiff(changes: FileChange[]): string {
  const parts: string[] = [];
  for (const change of changes) {
    const diff = renderDiff(change.relPath, change.oldContent, change.newContent);
    if (diff) {
      parts.push(diff);
    }
  }
  return parts.join("\n");
}

/**
 * Format a diff payload as a message suitable for sending to the agent.
 */
export function formatDiffMessage(changes: FileChange[]): string {
  const diff = renderBatchDiff(changes);
  if (!diff.trim()) {
    return "";
  }
  const fileCount = changes.length;
  const fileList = changes.map((c) => c.relPath).join(", ");
  return `The following ${fileCount} file${fileCount > 1 ? "s" : ""} changed: ${fileList}\n\n${diff}`;
}
