import { describe, expect, it } from "bun:test";
import { type FileChange, formatDiffMessage, renderBatchDiff, renderDiff } from "../src/diff.ts";

describe("diff", () => {
  describe("renderDiff", () => {
    it("should return null for no change", () => {
      expect(renderDiff("file.md", "same", "same")).toBeNull();
    });

    it("should render a new file diff", () => {
      const diff = renderDiff("file.md", null, "new content");
      expect(diff).toContain("file.md");
      expect(diff).toContain("+new content");
    });

    it("should render a deleted file diff", () => {
      const diff = renderDiff("file.md", "old content", null);
      expect(diff).toContain("file.md");
      expect(diff).toContain("-old content");
    });

    it("should render a modified file diff", () => {
      const diff = renderDiff("file.md", "line 1\nline 2", "line 1\nline 2 changed");
      expect(diff).toContain("file.md");
      expect(diff).toContain("-line 2");
      expect(diff).toContain("+line 2 changed");
    });

    it("should use stable project-relative paths", () => {
      const diff = renderDiff("src/docs/README.md", "old", "new");
      expect(diff).toContain("src/docs/README.md");
    });
  });

  describe("renderBatchDiff", () => {
    it("should combine multiple file diffs", () => {
      const changes: FileChange[] = [
        { relPath: "file1.md", oldContent: "a", newContent: "b" },
        { relPath: "file2.md", oldContent: "c", newContent: "d" },
      ];
      const diff = renderBatchDiff(changes);
      expect(diff).toContain("file1.md");
      expect(diff).toContain("file2.md");
    });

    it("should skip files with no changes", () => {
      const changes: FileChange[] = [
        { relPath: "file1.md", oldContent: "same", newContent: "same" },
        { relPath: "file2.md", oldContent: "c", newContent: "d" },
      ];
      const diff = renderBatchDiff(changes);
      expect(diff).toContain("file2.md");
      expect(diff).not.toContain("file1.md");
    });
  });

  describe("formatDiffMessage", () => {
    it("should include file list and diff content", () => {
      const changes: FileChange[] = [{ relPath: "file1.md", oldContent: "a", newContent: "b" }];
      const message = formatDiffMessage(changes);
      expect(message).toContain("file1.md");
      expect(message).toContain("1 file changed");
      expect(message).toContain("Index:");
    });

    it("should return empty string for no changes", () => {
      const changes: FileChange[] = [
        { relPath: "file1.md", oldContent: "same", newContent: "same" },
      ];
      const message = formatDiffMessage(changes);
      expect(message).toBe("");
    });

    it("should use plural for multiple files", () => {
      const changes: FileChange[] = [
        { relPath: "file1.md", oldContent: "a", newContent: "b" },
        { relPath: "file2.md", oldContent: "c", newContent: "d" },
      ];
      const message = formatDiffMessage(changes);
      expect(message).toContain("2 files changed");
    });
  });
});
