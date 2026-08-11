import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initCommand } from "../../src/init.ts";
import { scanCommand } from "../../src/watch.ts";
import { startSyntheticReceiver } from "./receiver.ts";

const token = `demo-${crypto.randomUUID()}`;
const receiver = startSyntheticReceiver({ token, sourceId: "synthetic:demo" });
const projectRoot = await mkdtemp(join(tmpdir(), "hypervigilant-http-demo-"));

try {
  await writeFile(join(projectRoot, "README.md"), "# Durable event demo\n");
  await initCommand({
    path: projectRoot,
    project: "http-event-demo",
    eventOnly: true,
    httpDestination: {
      url: receiver.url,
      authTokenEnv: "HYPERVIGILANT_DEMO_TOKEN",
      requestTimeoutMs: 5_000,
    },
    nonInteractive: true,
  });
  await scanCommand({
    path: projectRoot,
    runtimeEnv: {},
    eventEnv: { HYPERVIGILANT_DEMO_TOKEN: token },
    onStatus: (message) => console.log(`[demo] ${message}`),
  });

  const state = JSON.parse(
    await readFile(join(projectRoot, ".hypervigilant", "state.json"), "utf8"),
  ) as Record<string, unknown>;
  const output = state.eventOutput as Record<string, unknown>;
  const receipt = output.lastReceipt as Record<string, unknown>;
  if (output.pending !== undefined || receipt.sourceId !== "synthetic:demo") {
    throw new Error("HTTP event was not durably acknowledged.");
  }
  console.log(
    `[demo] Receipt proved: ${String(receipt.sourceId)} sequence ${String(receipt.sourceSequence)}.`,
  );
} finally {
  await receiver.stop();
  await rm(projectRoot, { recursive: true, force: true });
}
