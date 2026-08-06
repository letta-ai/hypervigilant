import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const target = join(import.meta.dir, "..", "src", "greeting.ts");
await writeFile(
	target,
	`export function formatGreeting(name: string): string {
\treturn \`Hi, \${name}!\`;
}
`,
	"utf8",
);
console.log("Introduced a greeting implementation that violates SPEC.md.");
