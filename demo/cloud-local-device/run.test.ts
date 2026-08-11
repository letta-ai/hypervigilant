import { describe, expect, it } from "bun:test";
import { assertLocalMarker, renderCloudLocalDeviceConfig } from "./run.ts";

describe("Cloud agent on a local device demo", () => {
  it("selects Cloud state while exposing only the trigger as watched input", () => {
    const source = renderCloudLocalDeviceConfig({
      agentId: "agent-cloud-test",
      model: "letta/auto",
    });
    const config = Bun.TOML.parse(source);
    expect(config.connection).toEqual({ backend: "cloud" });
    expect(config.agent_id).toBe("agent-cloud-test");
    expect(config.model).toBe("letta/auto");
    expect(config.include).toEqual(["trigger.md"]);
    expect(config.exclude).toContain("device-only-proof.txt");
    expect(config.instructions).toContain("Use the Read tool to read device-only-proof.txt");
  });

  it("requires the local-only marker in agent output", () => {
    expect(() => assertLocalMarker("read local-device-123", "local-device-123")).not.toThrow();
    expect(() => assertLocalMarker("no marker", "local-device-123")).toThrow(
      "Local-device execution was not proved",
    );
  });
});
