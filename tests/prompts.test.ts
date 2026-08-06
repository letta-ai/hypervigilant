import { describe, expect, it } from "bun:test";
import type { PromptRule } from "../src/config.ts";
import { formatPromptRuleSection, matchPromptRules, toPromptRuleEvent } from "../src/prompts.ts";

const rules: PromptRule[] = [
  {
    name: "spec-change",
    match: ["specs/**", "**/SPEC.md"],
    events: ["add", "change"],
    prompt: "Treat the changed specification as the contract.",
  },
  {
    name: "source-review",
    match: ["src/**/*.ts"],
    events: ["add", "change", "delete"],
    prompt: "Check source against the contract.",
    conversation: "source-review",
  },
];

describe("canned prompt rules", () => {
  it("maps watcher deletion events to user-facing delete events", () => {
    expect(toPromptRuleEvent("add")).toBe("add");
    expect(toPromptRuleEvent("change")).toBe("change");
    expect(toPromptRuleEvent("unlink")).toBe("delete");
  });

  it("matches globs and events with normalized separators", () => {
    const matches = matchPromptRules(rules, [
      { relPath: "specs\\SPEC-0004.md", event: "change" },
      { relPath: "src/app.ts", event: "delete" },
      { relPath: "specs/old.md", event: "delete" },
    ]);
    expect(matches.map((match) => match.rule.name)).toEqual(["spec-change", "source-review"]);
    expect(matches[0]?.changes).toEqual([{ relPath: "specs/SPEC-0004.md", event: "change" }]);
    expect(matches[1]?.changes).toEqual([{ relPath: "src/app.ts", event: "delete" }]);
  });

  it("includes each rule once and preserves rule and change order", () => {
    const matches = matchPromptRules(rules, [
      { relPath: "SPEC.md", event: "change" },
      { relPath: "specs/feature.md", event: "add" },
      { relPath: "src/feature.ts", event: "change" },
    ]);
    expect(matches).toHaveLength(2);
    expect(matches[0]?.changes.map((change) => change.relPath)).toEqual([
      "SPEC.md",
      "specs/feature.md",
    ]);
  });

  it("formats exact rule names, matching changes, and prompts", () => {
    const section = formatPromptRuleSection(
      matchPromptRules(rules, [
        { relPath: "SPEC.md", event: "change" },
        { relPath: "src/app.ts", event: "add" },
      ]),
    );
    expect(section).toContain('Rule "spec-change"');
    expect(section).toContain("Matched changes: change: SPEC.md");
    expect(section).toContain("Treat the changed specification as the contract.");
    expect(section).toContain('Conversation: "source-review" (filesystem read-only)');
    expect(section.indexOf('Rule "spec-change"')).toBeLessThan(
      section.indexOf('Rule "source-review"'),
    );
  });

  it("returns no section when no rules match", () => {
    expect(matchPromptRules(rules, [{ relPath: "README.md", event: "change" }])).toEqual([]);
    expect(formatPromptRuleSection([])).toBe("");
  });
});
