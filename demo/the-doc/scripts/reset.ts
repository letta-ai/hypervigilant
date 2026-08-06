import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const templatePath = resolve(import.meta.dir, "..", "PROJECT.md.example");
const projectPath = resolve(import.meta.dir, "..", "workspace", "PROJECT.md");
await mkdir(dirname(projectPath), { recursive: true });
await copyFile(templatePath, projectPath);
console.log(`Reset ${projectPath}`);
