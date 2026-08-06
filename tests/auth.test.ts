import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveCloudApiKey } from "../src/auth.ts";

describe("resolveCloudApiKey", () => {
  const root = join(import.meta.dirname, "tmp-auth");

  beforeEach(async () => {
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("uses an ambient Cloud key", () => {
    expect(resolveCloudApiKey(root, { LETTA_API_KEY: "sk-let-ambient" })).toBe("sk-let-ambient");
  });

  it("prefers a .env Cloud key over an inherited local-server key", async () => {
    await writeFile(join(root, ".env"), "LETTA_API_KEY=sk-let-from-file\n", "utf8");
    expect(resolveCloudApiKey(root, { LETTA_API_KEY: "local-server-uuid" })).toBe(
      "sk-let-from-file",
    );
  });

  it("prefers the project .env over an ambient Cloud key", async () => {
    await writeFile(join(root, ".env"), "LETTA_API_KEY=sk-let-project-org\n", "utf8");
    expect(resolveCloudApiKey(root, { LETTA_API_KEY: "sk-let-system-org" })).toBe(
      "sk-let-project-org",
    );
  });

  it("prefers the watched project before the invocation directory", async () => {
    const watched = join(root, "watched");
    const invocation = join(root, "invocation");
    await mkdir(watched, { recursive: true });
    await mkdir(invocation, { recursive: true });
    await writeFile(join(watched, ".env"), "LETTA_API_KEY=sk-let-watched\n", "utf8");
    await writeFile(join(invocation, ".env"), "LETTA_API_KEY=sk-let-invocation\n", "utf8");
    expect(resolveCloudApiKey([watched, invocation], {})).toBe("sk-let-watched");
  });

  it("does not fall through when the watched project declares an invalid key", async () => {
    const watched = join(root, "watched-invalid");
    const invocation = join(root, "invocation-valid");
    await mkdir(watched, { recursive: true });
    await mkdir(invocation, { recursive: true });
    await writeFile(join(watched, ".env"), "LETTA_API_KEY=local-server-uuid\n", "utf8");
    await writeFile(join(invocation, ".env"), "LETTA_API_KEY=sk-let-invocation\n", "utf8");
    expect(() => resolveCloudApiKey([watched, invocation], {})).toThrow(
      "watched-invalid/.env is not a Letta Cloud key",
    );
  });

  it("accepts quoted and exported .env values", async () => {
    await writeFile(join(root, ".env"), 'export LETTA_API_KEY="sk-let-quoted"\n', "utf8");
    expect(resolveCloudApiKey(root, {})).toBe("sk-let-quoted");
    await writeFile(join(root, ".env"), "LETTA_API_KEY=sk-let-commented # project key\n", "utf8");
    expect(resolveCloudApiKey(root, {})).toBe("sk-let-commented");
  });

  it("rejects a local-server key without a Cloud fallback", () => {
    expect(() => resolveCloudApiKey(root, { LETTA_API_KEY: "local-server-uuid" })).toThrow(
      "not a Letta Cloud key",
    );
  });
});
