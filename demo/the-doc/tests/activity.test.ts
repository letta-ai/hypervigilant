import { describe, expect, it } from "bun:test";
import { ActivityFeed, parseHypervigilantActivity } from "../activity.ts";

describe("The Doc activity feed", () => {
  it("tracks generic listeners and bounds their event history", () => {
    const feed = new ActivityFeed();
    let publications = 0;
    feed.subscribe(() => {
      publications += 1;
    });
    feed.upsert({
      id: "docs-agent",
      label: "Docs agent",
      kind: "Agent listener",
      target: "PROJECT.md",
      state: "starting",
      summary: "Starting",
    });
    for (let index = 0; index < 15; index += 1) {
      feed.update("docs-agent", {
        state: "working",
        summary: `Working ${index}`,
        event: `Event ${index}`,
      });
    }

    const [listener] = feed.snapshot();
    expect(listener?.label).toBe("Docs agent");
    expect(listener?.events).toHaveLength(12);
    expect(listener?.events[0]?.summary).toBe("Event 3");
    expect(listener?.events[11]?.summary).toBe("Event 14");
    expect(publications).toBe(16);
  });

  it("sanitizes listener text before publishing it", () => {
    const feed = new ActivityFeed();
    feed.upsert({
      id: "listener",
      label: "Unsafe\nname",
      kind: "Process\u0000type",
      target: "PROJECT.md",
      summary: "  starting\nnow  ",
    });
    feed.update("listener", {
      state: "failed",
      summary: "failed\u0000safely",
      event: "x".repeat(300),
    });

    const [listener] = feed.snapshot();
    expect(listener?.label).toBe("Unsafe name");
    expect(listener?.kind).toBe("Process type");
    expect(listener?.summary).toBe("failed safely");
    expect(listener?.events[0]?.summary).toHaveLength(160);
  });

  it("maps Hypervigilant lifecycle lines without forwarding arbitrary output", () => {
    expect(
      parseHypervigilantActivity(
        "[hypervigilant] Watching /private/project with secret-shaped context",
      ),
    ).toMatchObject({ state: "listening", summary: "Waiting for a saved change" });
    expect(
      parseHypervigilantActivity("[hypervigilant] Sending 1 saved change to the agent: PROJECT.md"),
    ).toEqual({
      state: "receiving",
      summary: "Reading the saved document diff",
      event: "Received 1 saved change",
    });
    expect(
      parseHypervigilantActivity(
        "assistant output [hypervigilant] YOLO auto-approved Edit: /private/PROJECT.md",
      ),
    ).toEqual({
      state: "working",
      summary: "Revising PROJECT.md",
      event: "Started a guarded document edit",
    });
    expect(parseHypervigilantActivity("[hypervigilant] Delivery complete.")).toEqual({
      state: "finished",
      summary: "Finished the document revision",
      event: "Finished the document revision",
      settlesToListening: true,
    });
    expect(parseHypervigilantActivity("[hypervigilant] ERROR: raw provider response")).toEqual({
      state: "failed",
      summary: "The last delivery failed. Check the terminal.",
      event: "Delivery failed",
    });
    expect(parseHypervigilantActivity("[hypervigilant] Delivery stopped (error): secret")).toEqual({
      state: "failed",
      summary: "The last delivery failed. Check the terminal.",
      event: "Delivery failed",
    });
    expect(
      parseHypervigilantActivity("[hypervigilant] First run: establishing the saved-file baseline..."),
    ).toEqual({ state: "starting", summary: "Preparing the document baseline" });
    expect(parseHypervigilantActivity("[hypervigilant] Baseline established.")).toEqual({
      state: "starting",
      summary: "Preparing the document baseline",
    });
    expect(parseHypervigilantActivity("arbitrary assistant output with tool input")).toBeNull();
  });
});
