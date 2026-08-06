import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const demoRoot = join(import.meta.dir, "..");
const sourcePath = join(demoRoot, "src", "greeting.ts");
const statePath = join(demoRoot, ".hypervigilant", "state.json");
const relPath = "src/greeting.ts";
const correct = `export function formatGreeting(name: string): string {
\tconst normalized = name.trim();
\treturn normalized ? \`Hello, \${normalized}!\` : "Hello, stranger!";
}
`;
const drift = `export function formatGreeting(name: string): string {
\treturn \`Hi, \${name}!\`;
}
`;

interface DemoState {
	snapshots?: Record<string, { content?: string }>;
}

async function savedContent(): Promise<string | undefined> {
	try {
		const state = JSON.parse(await readFile(statePath, "utf8")) as DemoState;
		return state.snapshots?.[relPath]?.content;
	} catch {
		return undefined;
	}
}

async function waitForSavedContent(expected: string): Promise<void> {
	const deadline = Date.now() + 120_000;
	while (Date.now() < deadline) {
		if ((await savedContent()) === expected) return;
		await Bun.sleep(250);
	}
	throw new Error(
		"The watcher did not deliver the reset within 120 seconds. Confirm it is running and inspect its error output.",
	);
}

const baseline = await savedContent();
const current = await readFile(sourcePath, "utf8");
if (!baseline) {
	throw new Error("Start the watcher and wait for its baseline before running this script.");
}

if (baseline === correct && current === correct) {
	await writeFile(sourcePath, drift, "utf8");
	console.log("Introduced contract drift. Watch for the approval-gated repair.");
} else if (baseline === correct && current === drift) {
	console.log("Contract drift is already pending. Watch the Hypervigilant terminal.");
} else if (baseline === drift && (current === drift || current === correct)) {
	if (current === drift) {
		await writeFile(sourcePath, correct, "utf8");
		console.log("Reset the demo. Waiting for Hypervigilant to deliver that change...");
	} else {
		console.log("The reset is already pending. Waiting for Hypervigilant to deliver it...");
	}
	await waitForSavedContent(correct);
	await writeFile(sourcePath, drift, "utf8");
	console.log("Introduced contract drift. Watch for the approval-gated repair.");
} else {
	throw new Error(
		"The demo source or saved snapshot is not in a recognized state. Run reset.ts, wait for Delivery complete, and try again.",
	);
}
