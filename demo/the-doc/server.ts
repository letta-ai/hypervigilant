import { constants, watch, type FSWatcher } from "node:fs";
import { copyFile, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ActivityFeed } from "./activity.ts";

const DEFAULT_MAX_DOCUMENT_BYTES = 256 * 1024;
const DEFAULT_MAX_ASSET_BYTES = 8 * 1024 * 1024;
const DEFAULT_HOSTNAME = "127.0.0.1";
const IMAGE_CONTENT_TYPES = new Map([
  [".avif", "image/avif"],
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
]);
const DEFAULT_PORT = 4317;

export type TheDoc = {
  markdown: string;
  revision: string;
};

export type SaveDocumentResult = TheDoc & {
  changed: boolean;
};

export type TheDocServerOptions = {
  documentPath?: string;
  hostname?: string;
  port?: number;
  maxDocumentBytes?: number;
  maxAssetBytes?: number;
  activityFeed?: ActivityFeed;
};

export type TheDocServer = {
  documentPath: string;
  hostname: string;
  port: number;
  url: string;
  stop: () => Promise<void>;
};

type SocketData = Record<string, never>;

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export function documentRevision(markdown: string): string {
  return new Bun.CryptoHasher("sha256").update(markdown).digest("hex");
}

function normalizedDocumentText(markdown: string): string {
  const normalized = markdown.replace(/\r\n?/g, "\n").trimEnd();
  return normalized ? `${normalized}\n` : "";
}

export async function readTheDoc(documentPath: string): Promise<TheDoc> {
  const markdown = await readFile(documentPath, "utf8");
  return { markdown, revision: documentRevision(markdown) };
}

async function atomicWriteDocument(documentPath: string, markdown: string): Promise<void> {
  const directory = dirname(documentPath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = join(
    directory,
    `.${basename(documentPath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, markdown, { encoding: "utf8", mode: 0o644 });
    await rename(temporaryPath, documentPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function saveTheDoc(
  documentPath: string,
  markdown: string,
  expectedRevision: string,
  maxDocumentBytes = DEFAULT_MAX_DOCUMENT_BYTES,
): Promise<SaveDocumentResult | { conflict: TheDoc }> {
  const current = await readTheDoc(documentPath);
  if (current.revision !== expectedRevision) return { conflict: current };
  if (normalizedDocumentText(markdown) === normalizedDocumentText(current.markdown)) {
    return { ...current, changed: false };
  }

  const bytes = Buffer.byteLength(markdown, "utf8");
  if (bytes > maxDocumentBytes) {
    throw new RangeError(`PROJECT.md exceeds the ${maxDocumentBytes}-byte limit.`);
  }
  if (markdown.includes("\0")) throw new TypeError("PROJECT.md must contain text only.");

  await atomicWriteDocument(documentPath, markdown);
  return {
    markdown,
    revision: documentRevision(markdown),
    changed: true,
  };
}

async function readAsset(path: string, contentType: string): Promise<Response> {
  try {
    const headers: Record<string, string> = {
      "cache-control": "no-store",
      "content-type": contentType,
      "x-content-type-options": "nosniff",
    };
    if (contentType.startsWith("text/html")) {
      headers["content-security-policy"] =
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
      headers["referrer-policy"] = "no-referrer";
    }
    return new Response(await readFile(path), { headers });
  } catch {
    return assetNotFound();
  }
}

function assetNotFound(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { "cache-control": "no-store" },
  });
}

export async function readWorkspaceImage(
  workspaceRoot: string,
  encodedPath: string,
  maxAssetBytes = DEFAULT_MAX_ASSET_BYTES,
): Promise<Response> {
  if (!encodedPath || encodedPath.length > 1024) return assetNotFound();
  let requestedPath: string;
  try {
    requestedPath = decodeURIComponent(encodedPath);
  } catch {
    return assetNotFound();
  }
  const segments = requestedPath.split("/");
  if (
    requestedPath.includes("\0") ||
    requestedPath.includes("\\") ||
    isAbsolute(requestedPath) ||
    /^[A-Za-z]:/.test(requestedPath) ||
    segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))
  ) {
    return assetNotFound();
  }

  const contentType = IMAGE_CONTENT_TYPES.get(extname(requestedPath).toLowerCase());
  if (!contentType) return assetNotFound();

  try {
    const resolvedWorkspace = resolve(workspaceRoot);
    const candidate = resolve(resolvedWorkspace, requestedPath);
    const lexicalPath = relative(resolvedWorkspace, candidate);
    if (!lexicalPath || lexicalPath === ".." || lexicalPath.startsWith(`..${sep}`) || isAbsolute(lexicalPath)) {
      return assetNotFound();
    }

    const [realWorkspace, realCandidate] = await Promise.all([
      realpath(resolvedWorkspace),
      realpath(candidate),
    ]);
    const realRelativePath = relative(realWorkspace, realCandidate);
    if (
      !realRelativePath ||
      realRelativePath === ".." ||
      realRelativePath.startsWith(`..${sep}`) ||
      isAbsolute(realRelativePath)
    ) {
      return assetNotFound();
    }

    const file = await stat(realCandidate);
    if (!file.isFile() || file.size > maxAssetBytes) return assetNotFound();
    return new Response(await readFile(realCandidate), {
      headers: {
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; sandbox",
        "content-type": contentType,
        "cross-origin-resource-policy": "same-origin",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return assetNotFound();
  }
}

export async function startTheDocServer(
  options: TheDocServerOptions = {},
): Promise<TheDocServer> {
  const demoRoot = import.meta.dir;
  const documentPath = resolve(
    options.documentPath ?? join(demoRoot, "workspace", "PROJECT.md"),
  );
  if (!options.documentPath) {
    await mkdir(dirname(documentPath), { recursive: true });
    try {
      await copyFile(join(demoRoot, "PROJECT.md.example"), documentPath, constants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const hostname = options.hostname ?? DEFAULT_HOSTNAME;
  if (hostname !== DEFAULT_HOSTNAME && hostname !== "localhost") {
    throw new Error("The Doc server only binds to localhost.");
  }
  const port = options.port ?? DEFAULT_PORT;
  const maxDocumentBytes = options.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES;
  const maxAssetBytes = options.maxAssetBytes ?? DEFAULT_MAX_ASSET_BYTES;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("Port must be an integer from 0 through 65535.");
  }
  if (!Number.isInteger(maxDocumentBytes) || maxDocumentBytes < 1) {
    throw new Error("The document byte limit must be a positive integer.");
  }
  if (!Number.isInteger(maxAssetBytes) || maxAssetBytes < 1) {
    throw new Error("The asset byte limit must be a positive integer.");
  }

  let latestRevision = (await readTheDoc(documentPath)).revision;
  const sockets = new Set<ServerWebSocket<SocketData>>();
  let fileWatcher: FSWatcher | null = null;
  let notificationTimer: ReturnType<typeof setTimeout> | null = null;

  const notifyFileChange = (): void => {
    if (notificationTimer) clearTimeout(notificationTimer);
    notificationTimer = setTimeout(() => {
      notificationTimer = null;
      void readTheDoc(documentPath)
        .then((document) => {
          if (document.revision === latestRevision) return;
          latestRevision = document.revision;
          const event = JSON.stringify({
            type: "document_changed",
            revision: document.revision,
          });
          for (const socket of sockets) socket.send(event);
        })
        .catch(() => {});
    }, 35);
  };

  const server = Bun.serve<SocketData>({
    hostname,
    port,
    fetch: async (request, bunServer) => {
      const url = new URL(request.url);
      if (url.pathname === "/live") {
        if (bunServer.upgrade(request, { data: {} })) return undefined;
        return new Response("WebSocket upgrade required", { status: 400 });
      }

      if (request.method === "GET" && url.pathname === "/api/document") {
        return json(await readTheDoc(documentPath));
      }

      if (request.method === "PUT" && url.pathname === "/api/document") {
        const contentLength = Number(request.headers.get("content-length") ?? 0);
        if (contentLength > maxDocumentBytes * 2) {
          return json({ error: "The request is too large." }, 413);
        }

        let payload: unknown;
        try {
          const source = await request.text();
          if (Buffer.byteLength(source, "utf8") > maxDocumentBytes * 2) {
            return json({ error: "The request is too large." }, 413);
          }
          payload = JSON.parse(source);
        } catch {
          return json({ error: "Send a JSON document." }, 400);
        }
        if (
          typeof payload !== "object" ||
          payload === null ||
          typeof (payload as { markdown?: unknown }).markdown !== "string" ||
          typeof (payload as { revision?: unknown }).revision !== "string"
        ) {
          return json({ error: "Send markdown and revision strings." }, 400);
        }

        try {
          const result = await saveTheDoc(
            documentPath,
            (payload as { markdown: string }).markdown,
            (payload as { revision: string }).revision,
            maxDocumentBytes,
          );
          if ("conflict" in result) return json(result.conflict, 409);
          latestRevision = result.revision;
          return json(result);
        } catch (error) {
          if (error instanceof RangeError) return json({ error: error.message }, 413);
          if (error instanceof TypeError) return json({ error: error.message }, 400);
          throw error;
        }
      }

      if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
      const assetPrefix = "/project-assets/";
      if (url.pathname.startsWith(assetPrefix)) {
        return readWorkspaceImage(
          dirname(documentPath),
          url.pathname.slice(assetPrefix.length),
          maxAssetBytes,
        );
      }
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return readAsset(join(demoRoot, "index.html"), "text/html; charset=utf-8");
      }
      if (url.pathname === "/app.js") {
        return readAsset(join(demoRoot, "app.js"), "text/javascript; charset=utf-8");
      }
      if (url.pathname === "/styles.css") {
        return readAsset(join(demoRoot, "styles.css"), "text/css; charset=utf-8");
      }
      return assetNotFound();
    },
    websocket: {
      open(socket) {
        sockets.add(socket);
        socket.send(
          JSON.stringify({
            type: "listeners",
            listeners: options.activityFeed?.snapshot() ?? [],
          }),
        );
      },
      close(socket) {
        sockets.delete(socket);
      },
      message() {
        // The browser receives file events but cannot send commands through this socket.
      },
    },
  });

  const unsubscribeActivity = options.activityFeed?.subscribe((listeners) => {
    const event = JSON.stringify({ type: "listeners", listeners });
    for (const socket of sockets) socket.send(event);
  });

  fileWatcher = watch(dirname(documentPath), (_event, filename) => {
    if (filename?.toString() === basename(documentPath)) notifyFileChange();
  });

  return {
    documentPath,
    hostname,
    port: server.port,
    url: `http://${hostname}:${server.port}`,
    stop: async () => {
      if (notificationTimer) clearTimeout(notificationTimer);
      unsubscribeActivity?.();
      fileWatcher?.close();
      await server.stop(true);
      sockets.clear();
    },
  };
}

if (import.meta.main) {
  const portArgument = process.argv.find((argument) => argument.startsWith("--port="));
  const port = portArgument ? Number(portArgument.slice("--port=".length)) : undefined;
  const server = await startTheDocServer({ port });
  console.log(`The Doc editor: ${server.url}`);
}
