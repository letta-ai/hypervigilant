import { describe, expect, it } from "bun:test";
import { renderDiffPreview, renderDiffPreviews } from "../src/approval-diff.ts";

const advancedPreview = {
  mode: "advanced",
  fileName: "greeting.ts",
  hunks: [
    {
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 4,
      lines: [
        {
          type: "context",
          content: "export function formatGreeting(name: string): string {",
        },
        { type: "remove", content: `\treturn \`Hi, \${name}!\`;` },
        { type: "add", content: "\tconst normalized = name.trim();" },
        {
          type: "add",
          content: `\treturn normalized ? \`Hello, \${normalized}!\` : "Hello, stranger!";`,
        },
        { type: "context", content: "}" },
      ],
    },
  ],
};

describe("approval diff rendering", () => {
  it("renders an advanced preview as a unified diff", () => {
    expect(renderDiffPreview(advancedPreview)).toBe(`--- a/greeting.ts
+++ b/greeting.ts
@@ -1,3 +1,4 @@
 export function formatGreeting(name: string): string {
-\treturn \`Hi, \${name}!\`;
+\tconst normalized = name.trim();
+\treturn normalized ? \`Hello, \${normalized}!\` : "Hello, stranger!";
 }`);
  });

  it("renders unavailable preview reasons without dumping JSON", () => {
    expect(
      renderDiffPreview({
        mode: "fallback",
        fileName: "large.txt",
        reason: "file is too large",
      }),
    ).toBe("large.txt: diff preview unavailable (file is too large)");
  });

  it("rejects malformed previews and filters them from lists", () => {
    expect(renderDiffPreview({ mode: "advanced", fileName: "bad.ts", hunks: null })).toBeNull();
    expect(renderDiffPreviews([null, advancedPreview])).toHaveLength(1);
  });

  it("uses ANSI colors only when requested", () => {
    const rendered = renderDiffPreview(advancedPreview, true);
    expect(rendered).toContain("\u001b[31m-\treturn");
    expect(rendered).toContain("\u001b[32m+\tconst normalized");
    expect(rendered).toContain("\u001b[36m@@ -1,3 +1,4 @@");
  });
});
