import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const target = join(import.meta.dir, "..", "src", "greeting.ts");
await writeFile(
	target,
	`export function formatGreeting(name: string): string {
\tconst normalized = name.trim();
\treturn normalized ? \`Hello, \${normalized}!\` : "Hello, stranger!";
}
`,
	"utf8",
);
console.log("Restored the greeting implementation.");
