import picomatch from "picomatch";
import type { PromptRule, PromptRuleEvent } from "./config.ts";

export interface PromptChange {
  relPath: string;
  event: PromptRuleEvent;
}

export interface MatchedPromptRule {
  rule: PromptRule;
  changes: PromptChange[];
}

export function toPromptRuleEvent(event: "add" | "change" | "unlink"): PromptRuleEvent {
  return event === "unlink" ? "delete" : event;
}

export function matchPromptRules(
  rules: PromptRule[],
  changes: PromptChange[],
): MatchedPromptRule[] {
  return rules.flatMap((rule) => {
    const matchers = rule.match.map((glob) => picomatch(glob, { dot: true }));
    const matchedChanges = changes.flatMap((change) => {
      const normalizedPath = change.relPath.replace(/\\/g, "/");
      const matches =
        rule.events.includes(change.event) && matchers.some((matcher) => matcher(normalizedPath));
      return matches ? [{ ...change, relPath: normalizedPath }] : [];
    });
    return matchedChanges.length > 0 ? [{ rule, changes: matchedChanges }] : [];
  });
}

export function formatPromptRuleSection(matches: MatchedPromptRule[]): string {
  if (matches.length === 0) return "";
  const sections = matches.map(({ rule, changes }) => {
    const matched = changes.map((change) => `${change.event}: ${change.relPath}`).join(", ");
    const conversation = rule.conversation
      ? `\nConversation: ${JSON.stringify(rule.conversation)} (filesystem read-only)`
      : "";
    return `Rule ${JSON.stringify(rule.name)}${conversation}\nMatched changes: ${matched}\n${rule.prompt.trim()}`;
  });
  return `Canned prompt rules activated for this delivery:\n\n${sections.join("\n\n")}`;
}
