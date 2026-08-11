import { expect, it } from "bun:test";
import { configSchema } from "../../src/config.ts";
import {
  deliverPendingHttpEvent,
  enqueueEvent,
  recordHttpReceipt,
} from "../../src/event-destination.ts";
import { hashEventBody } from "../../src/event-schema.ts";
import type { HypervigilantState } from "../../src/state.ts";
import { startSyntheticReceiver } from "./receiver.ts";

it("accepts one authenticated event and returns the same receipt for an exact retry", async () => {
  const token = "demo-test-token";
  const receiver = startSyntheticReceiver({ token, sourceId: "synthetic:demo-test" });
  try {
    const config = configSchema.parse({
      version: 1,
      project: "demo-test",
      destinations: {
        agent: false,
        http: {
          url: receiver.url,
          authTokenEnv: "DEMO_TOKEN",
          requestTimeoutMs: 1_000,
        },
      },
    });
    const state: HypervigilantState = {
      version: 1,
      connectionKey: "agent-disabled",
      projectConversation: { conversationId: null },
      fileConversations: {},
      snapshots: {},
    };
    const queued = enqueueEvent(
      state,
      config,
      [
        {
          relPath: "demo.md",
          absPath: "/demo/demo.md",
          event: "add",
          kind: "text",
          oldContent: null,
          newContent: "demo\n",
          hash: hashEventBody("demo\n"),
          size: 5,
        },
      ],
      "agent-disabled",
    );
    const pending = queued.eventOutput?.pending;
    if (!pending) throw new Error("missing pending demo event");
    const first = await deliverPendingHttpEvent(pending, { env: { DEMO_TOKEN: token } });
    const second = await deliverPendingHttpEvent(pending, { env: { DEMO_TOKEN: token } });
    expect(second).toEqual(first);
    expect(receiver.receipts.size).toBe(1);
    expect(recordHttpReceipt(queued, first).eventOutput?.pending?.httpReceipt).toEqual(first);
  } finally {
    await receiver.stop();
  }
});
