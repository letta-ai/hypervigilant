import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ActivityFeed } from "../activity.ts";
import {
  documentRevision,
  saveTheDoc,
  type TheDocServer,
  startTheDocServer,
} from "../server.ts";

const testRoot = join(import.meta.dir, "tmp-the-doc");
const documentPath = join(testRoot, "PROJECT.md");
const outsideImagePath = join(import.meta.dir, "outside-the-doc.svg");
const initialMarkdown = "# New Project\n\nStart here.\n";
const canonicalMarkdown = `# The Doc

Whatever you type here will try its best to exist.

Edit this file however you want, then hit "Save".

Have fun.
`;
let server: TheDocServer | null = null;
let activityFeed: ActivityFeed;

beforeEach(async () => {
  await rm(testRoot, { recursive: true, force: true });
  await mkdir(testRoot, { recursive: true });
  await writeFile(documentPath, initialMarkdown, "utf8");
  activityFeed = new ActivityFeed();
  activityFeed.upsert({
    id: "hypervigilant",
    label: "Hypervigilant",
    kind: "Agent listener",
    target: "PROJECT.md",
    state: "listening",
    summary: "Waiting for a saved change",
  });
  server = await startTheDocServer({
    documentPath,
    port: 0,
    maxDocumentBytes: 1024,
    maxAssetBytes: 1024,
    activityFeed,
  });
});

afterEach(async () => {
  await server?.stop();
  server = null;
  await rm(testRoot, { recursive: true, force: true });
  await rm(outsideImagePath, { force: true });
});

describe("The Doc server", () => {
  it("ships Cameron's canonical starting document", async () => {
    expect(await Bun.file(join(import.meta.dir, "..", "PROJECT.md.example")).text()).toBe(
      canonicalMarkdown,
    );
  });

  it("reads and saves the fixed Markdown document", async () => {
    const current = await fetch(`${server?.url}/api/document`).then((response) => response.json());
    expect(current).toEqual({
      markdown: initialMarkdown,
      revision: documentRevision(initialMarkdown),
    });

    const markdown = "# New Project\n\nA saved idea.\n";
    const response = await fetch(`${server?.url}/api/document`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ markdown, revision: current.revision }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      markdown,
      revision: documentRevision(markdown),
      changed: true,
    });
    expect(await Bun.file(documentPath).text()).toBe(markdown);
  });

  it("does not rewrite an unchanged document", async () => {
    const before = await stat(documentPath);
    const response = await fetch(`${server?.url}/api/document`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        markdown: initialMarkdown,
        revision: documentRevision(initialMarkdown),
      }),
    });
    const after = await stat(documentPath);

    expect(response.status).toBe(200);
    expect((await response.json()).changed).toBe(false);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("does not rewrite equivalent line endings", async () => {
    const windowsMarkdown = initialMarkdown.replaceAll("\n", "\r\n");
    await writeFile(documentPath, windowsMarkdown, "utf8");
    const before = await stat(documentPath);
    const response = await fetch(`${server?.url}/api/document`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        markdown: initialMarkdown,
        revision: documentRevision(windowsMarkdown),
      }),
    });
    const after = await stat(documentPath);

    expect(response.status).toBe(200);
    expect((await response.json()).changed).toBe(false);
    expect(after.ino).toBe(before.ino);
    expect(await Bun.file(documentPath).text()).toBe(windowsMarkdown);
  });

  it("returns the file version when a stale revision tries to save", async () => {
    const fileMarkdown = "# Agent revision\n";
    await writeFile(documentPath, fileMarkdown, "utf8");
    const response = await fetch(`${server?.url}/api/document`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        markdown: "# Stale local draft\n",
        revision: documentRevision(initialMarkdown),
      }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      markdown: fileMarkdown,
      revision: documentRevision(fileMarkdown),
    });
    expect(await Bun.file(documentPath).text()).toBe(fileMarkdown);
  });

  it("rejects oversized input before reading the current document", async () => {
    await expect(
      saveTheDoc(join(testRoot, "missing", "PROJECT.md"), "x".repeat(1025), "stale", 1024),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("rejects invalid and oversized writes", async () => {
    const malformed = await fetch(`${server?.url}/api/document`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ markdown: 42, revision: "old" }),
    });
    expect(malformed.status).toBe(400);

    const oversized = await fetch(`${server?.url}/api/document`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        markdown: "x".repeat(1025),
        revision: documentRevision(initialMarkdown),
      }),
    });
    expect(oversized.status).toBe(413);
  });

  it("broadcasts external file revisions", async () => {
    const socket = new WebSocket(`${server?.url.replace("http://", "ws://")}/live`);
    const changedEvent = new Promise<{ type: string; revision: string }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for file event")), 2000);
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data));
        if (message.type !== "document_changed") return;
        clearTimeout(timeout);
        resolve(message);
      });
    });
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("WebSocket failed")), { once: true });
    });

    const externalMarkdown = "# Revised by an agent\n";
    await writeFile(documentPath, externalMarkdown, "utf8");
    expect(await changedEvent).toEqual({
      type: "document_changed",
      revision: documentRevision(externalMarkdown),
    });
    socket.close();
  });

  it("sends listener snapshots and structured updates", async () => {
    const socket = new WebSocket(`${server?.url.replace("http://", "ws://")}/live`);
    const nextListenerSnapshot = () =>
      new Promise<Array<{ state: string; summary: string }>>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timed out waiting for listeners")), 2000);
        const onMessage = (event: MessageEvent) => {
          const message = JSON.parse(String(event.data));
          if (message.type !== "listeners") return;
          clearTimeout(timeout);
          socket.removeEventListener("message", onMessage);
          resolve(message.listeners);
        };
        socket.addEventListener("message", onMessage);
      });
    const initialSnapshot = nextListenerSnapshot();
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("WebSocket failed")), { once: true });
    });
    expect(await initialSnapshot).toEqual([
      expect.objectContaining({ state: "listening", summary: "Waiting for a saved change" }),
    ]);

    const updatedSnapshot = nextListenerSnapshot();
    activityFeed.update("hypervigilant", {
      state: "working",
      summary: "Revising PROJECT.md",
      event: "Started a guarded document edit",
    });
    expect(await updatedSnapshot).toEqual([
      expect.objectContaining({
        state: "working",
        summary: "Revising PROJECT.md",
        events: [expect.objectContaining({ summary: "Started a guarded document edit" })],
      }),
    ]);
    socket.close();
  });

  it("sends a fresh listener snapshot after reconnect", async () => {
    const connect = async () => {
      const socket = new WebSocket(`${server?.url.replace("http://", "ws://")}/live`);
      const snapshot = new Promise<Array<{ state: string }>>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timed out waiting for listeners")), 2000);
        socket.addEventListener("message", (event) => {
          const message = JSON.parse(String(event.data));
          if (message.type !== "listeners") return;
          clearTimeout(timeout);
          resolve(message.listeners);
        });
      });
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error("WebSocket failed")), { once: true });
      });
      return { socket, listeners: await snapshot };
    };

    const first = await connect();
    expect(first.listeners[0]?.state).toBe("listening");
    first.socket.close();
    await Bun.sleep(10);
    activityFeed.update("hypervigilant", {
      state: "finished",
      summary: "Finished the document revision",
      event: "Finished the document revision",
    });

    const second = await connect();
    expect(second.listeners[0]?.state).toBe("finished");
    second.socket.close();
  });

  it("serves allowlisted workspace images with safe headers", async () => {
    const assetsRoot = join(testRoot, "images");
    await mkdir(assetsRoot);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>';
    await writeFile(join(assetsRoot, "good boy.svg"), svg, "utf8");

    const response = await fetch(`${server?.url}/project-assets/images/good%20boy.svg`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await response.text()).toBe(svg);
  });

  it("rejects unsafe and non-image workspace asset paths", async () => {
    await writeFile(join(testRoot, "notes.txt"), "not an image", "utf8");
    await writeFile(join(testRoot, ".secret.png"), "hidden", "utf8");
    await writeFile(join(testRoot, "too-big.png"), new Uint8Array(1025));
    await mkdir(join(testRoot, "folder.png"));
    await writeFile(outsideImagePath, "<svg/>", "utf8");
    await symlink(outsideImagePath, join(testRoot, "outside.svg"));

    const paths = [
      "PROJECT.md",
      "notes.txt",
      ".secret.png",
      "too-big.png",
      "folder.png",
      "outside.svg",
      "%2e%2e%2fPROJECT.md",
      "%2fetc%2fpasswd.png",
      "%5c%5cserver%5csecret.png",
      "%E0%A4%A.png",
    ];
    for (const path of paths) {
      const response = await fetch(`${server?.url}/project-assets/${path}`);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Not found");
    }
  });

  it("binds only to localhost and serves fixed paths", async () => {
    expect(server?.hostname).toBe("127.0.0.1");
    const page = await fetch(`${server?.url}/`);
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const missing = await fetch(`${server?.url}/missing.js`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");
    expect((await fetch(`${server?.url}/../package.json`)).status).toBe(404);
    await expect(
      startTheDocServer({ documentPath, hostname: "0.0.0.0", port: 0 }),
    ).rejects.toThrow("only binds to localhost");
  });
});
