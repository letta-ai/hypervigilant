import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SPEC_DIRECTORY = join(import.meta.dir, "..", "specs");
const STATUS_PATH = join(SPEC_DIRECTORY, "STATUS.md");
const VALID_STATUSES = new Set(["draft", "review", "approved", "implemented", "superseded"]);

type Spec = {
  file: string;
  id: string;
  title: string;
  status: string;
  dependencies: string[];
  supersedes: string[];
  implementationLinks: string[];
};

function parseList(value: string | undefined): string[] {
  if (!value || value === "[]") return [];
  if (!value.startsWith("[") || !value.endsWith("]")) {
    throw new Error(`Expected an inline list, received: ${value}`);
  }
  return value
    .slice(1, -1)
    .split(",")
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
}

function parseSpec(file: string, source: string): Spec {
  const match = source.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match?.[1]) throw new Error(`${file}: missing YAML frontmatter`);

  const fields = new Map<string, string>();
  for (const line of match[1].split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }

  const id = fields.get("id");
  const title = fields.get("title");
  const status = fields.get("status");
  if (!id || !title || !status) throw new Error(`${file}: id, title, and status are required`);
  if (!/^SPEC-\d{4}$/.test(id)) throw new Error(`${file}: invalid spec id ${id}`);
  if (!VALID_STATUSES.has(status)) throw new Error(`${file}: invalid status ${status}`);

  return {
    file,
    id,
    title,
    status,
    dependencies: parseList(fields.get("dependencies")),
    supersedes: parseList(fields.get("supersedes")),
    implementationLinks: parseList(fields.get("implementation_links")),
  };
}

function validate(specs: Spec[]): void {
  const byId = new Map(specs.map((spec) => [spec.id, spec]));
  if (byId.size !== specs.length) throw new Error("Duplicate spec IDs found");

  for (const spec of specs) {
    for (const dependency of spec.dependencies) {
      const target = byId.get(dependency);
      if (!target) throw new Error(`${spec.file}: missing dependency ${dependency}`);
      if (["review", "approved", "implemented"].includes(spec.status)) {
        if (!["approved", "implemented"].includes(target.status)) {
          throw new Error(`${spec.file}: dependency ${dependency} is ${target.status}`);
        }
      }
    }
    for (const supersededId of spec.supersedes) {
      if (!byId.has(supersededId))
        throw new Error(`${spec.file}: missing superseded spec ${supersededId}`);
    }
    if (spec.status === "implemented" && spec.implementationLinks.length === 0) {
      throw new Error(`${spec.file}: implemented specs need implementation_links`);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`Dependency cycle includes ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependencies ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const spec of specs) visit(spec.id);
}

function renderStatus(specs: Spec[]): string {
  const rows = [...specs]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(
      (spec) =>
        `| ${spec.id} | ${spec.title} | ${spec.status} | ${spec.dependencies.join(", ") || "None"} |`,
    );
  return [
    "# Specification status",
    "",
    "| ID | Title | Status | Dependencies |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

const files = (await readdir(SPEC_DIRECTORY)).filter((file) => /^SPEC-\d{4}-.+\.md$/.test(file));
const specs = await Promise.all(
  files.map(async (file) => parseSpec(file, await readFile(join(SPEC_DIRECTORY, file), "utf8"))),
);
validate(specs);

const expectedStatus = renderStatus(specs);
if (process.argv.includes("--update")) {
  await writeFile(STATUS_PATH, expectedStatus);
  console.log(`Updated ${STATUS_PATH}`);
} else {
  const currentStatus = await readFile(STATUS_PATH, "utf8");
  if (currentStatus !== expectedStatus) {
    throw new Error("specs/STATUS.md is stale. Run bun run spec:update.");
  }
  console.log(`Validated ${specs.length} specification${specs.length === 1 ? "" : "s"}.`);
}
