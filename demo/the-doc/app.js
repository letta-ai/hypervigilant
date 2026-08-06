const editor = document.querySelector("#editor");
const statusLabel = document.querySelector("#status-label");
const conflictPanel = document.querySelector("#conflict");
const useFileButton = document.querySelector("#use-file");
const keepDraftButton = document.querySelector("#keep-draft");
const listenerList = document.querySelector("#listener-list");
const listenerCount = document.querySelector("#listener-count");

if (
  !(editor instanceof HTMLElement) ||
  !(statusLabel instanceof HTMLElement) ||
  !(conflictPanel instanceof HTMLElement) ||
  !(useFileButton instanceof HTMLButtonElement) ||
  !(keepDraftButton instanceof HTMLButtonElement) ||
  !(listenerList instanceof HTMLElement) ||
  !(listenerCount instanceof HTMLElement)
) {
  throw new Error("The Doc editor is missing required elements.");
}

let revision = "";
let cleanMarkdown = "";
let dirty = false;
let saving = false;
let queuedFileSignal = false;
let pendingFileDocument = null;
let reconnectTimer = null;
let waitingTimer = null;
let latestListeners = [];
let receivedListenerSnapshot = false;
const listenerFeedTimer = setTimeout(() => {
  if (receivedListenerSnapshot) return;
  listenerCount.textContent = "Restart needed";
  listenerList.replaceChildren();
  const message = document.createElement("p");
  message.className = "listener-empty";
  message.textContent = "Restart The Doc to connect the listener feed.";
  listenerList.append(message);
}, 2500);

function setActivity(activity, label) {
  document.body.dataset.activity = activity;
  statusLabel.textContent = label;
}

function markRevisionArrival(activity, label) {
  document.body.dataset.activity = "idle";
  requestAnimationFrame(() => setActivity(activity, label));
}

const LISTENER_STATE_LABELS = {
  starting: "Starting",
  listening: "Listening",
  receiving: "Receiving",
  working: "Working",
  finished: "Finished",
  failed: "Failed",
  offline: "Offline",
};

function renderListeners(listeners) {
  receivedListenerSnapshot = true;
  clearTimeout(listenerFeedTimer);
  latestListeners = Array.isArray(listeners) ? listeners : [];
  listenerList.replaceChildren();
  listenerCount.textContent = `${latestListeners.length} ${latestListeners.length === 1 ? "process" : "processes"}`;

  if (latestListeners.length === 0) {
    const empty = document.createElement("p");
    empty.className = "listener-empty";
    empty.textContent = "No listeners are connected. Start The Doc to watch saved diffs.";
    listenerList.append(empty);
    return;
  }

  for (const listener of latestListeners) {
    if (!listener || typeof listener !== "object" || typeof listener.label !== "string") continue;
    const state = Object.hasOwn(LISTENER_STATE_LABELS, listener.state) ? listener.state : "offline";
    const item = document.createElement("article");
    item.className = "listener-item";
    item.dataset.state = state;

    const header = document.createElement("header");
    header.className = "listener-item-header";
    const dot = document.createElement("span");
    dot.className = "listener-state-dot";
    dot.setAttribute("aria-hidden", "true");

    const name = document.createElement("div");
    name.className = "listener-item-name";
    const heading = document.createElement("h3");
    heading.textContent = listener.label;
    const metadata = document.createElement("p");
    const kind = typeof listener.kind === "string" ? listener.kind : "Process";
    const target = typeof listener.target === "string" ? listener.target : "PROJECT.md";
    metadata.textContent = `${kind} · ${target}`;
    name.append(heading, metadata);

    const stateLabel = document.createElement("span");
    stateLabel.className = "listener-state-label";
    stateLabel.textContent = LISTENER_STATE_LABELS[state];
    header.append(dot, name, stateLabel);

    const summary = document.createElement("p");
    summary.className = "listener-summary";
    summary.textContent =
      typeof listener.summary === "string" ? listener.summary : "No activity reported";
    item.append(header, summary);

    const events = Array.isArray(listener.events) ? listener.events.slice(-6).reverse() : [];
    if (events.length > 0) {
      const eventList = document.createElement("ol");
      eventList.className = "listener-events";
      for (const event of events) {
        if (!event || typeof event.summary !== "string") continue;
        const eventItem = document.createElement("li");
        eventItem.className = "listener-event";
        const time = document.createElement("time");
        const date = new Date(event.at);
        time.dateTime = Number.isNaN(date.getTime()) ? "" : date.toISOString();
        time.textContent = Number.isNaN(date.getTime())
          ? "now"
          : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        const text = document.createElement("span");
        text.textContent = event.summary;
        eventItem.append(time, text);
        eventList.append(eventItem);
      }
      item.append(eventList);
    }
    listenerList.append(item);
  }
}

function markListenersOffline() {
  if (latestListeners.length === 0) return;
  renderListeners(
    latestListeners.map((listener) => ({
      ...listener,
      state: "offline",
      summary: "Activity connection lost",
    })),
  );
}

function normalizeMarkdown(markdown) {
  const normalized = markdown.replace(/\r\n?/g, "\n").trimEnd();
  return normalized ? `${normalized}\n` : "";
}

function projectAssetUrl(source) {
  const normalized = source.replace(/^\.\/+/, "");
  if (
    !normalized ||
    normalized.length > 512 ||
    normalized.includes("\\") ||
    normalized.includes("?") ||
    normalized.includes("#") ||
    /^[A-Za-z][A-Za-z\d+.-]*:/.test(normalized)
  ) {
    return null;
  }
  try {
    const segments = normalized.split("/").map((segment) => decodeURIComponent(segment));
    if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))) {
      return null;
    }
    return `/project-assets/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
  } catch {
    return null;
  }
}

function appendInlineMarkdown(parent, source) {
  const tokenPattern = /(!\[[^\]\n]*\]\([^)\s]+\)|\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g;
  let cursor = 0;
  for (const match of source.matchAll(tokenPattern)) {
    const index = match.index ?? 0;
    if (index > cursor) parent.append(document.createTextNode(source.slice(cursor, index)));
    const token = match[0];
    if (token.startsWith("![")) {
      const separator = token.lastIndexOf("](");
      const assetPath = token.slice(separator + 2, -1);
      const assetUrl = projectAssetUrl(assetPath);
      if (!assetUrl) {
        parent.append(document.createTextNode(token));
      } else {
        const image = document.createElement("img");
        image.alt = token.slice(2, separator);
        image.src = assetUrl;
        image.dataset.assetPath = assetPath;
        image.loading = "lazy";
        image.decoding = "async";
        parent.append(image);
      }
    } else if (token.startsWith("**")) {
      const strong = document.createElement("strong");
      strong.textContent = token.slice(2, -2);
      parent.append(strong);
    } else if (token.startsWith("*")) {
      const emphasis = document.createElement("em");
      emphasis.textContent = token.slice(1, -1);
      parent.append(emphasis);
    } else if (token.startsWith("`")) {
      const code = document.createElement("code");
      code.textContent = token.slice(1, -1);
      parent.append(code);
    } else {
      const separator = token.lastIndexOf("](");
      const anchor = document.createElement("a");
      anchor.textContent = token.slice(1, separator);
      anchor.href = token.slice(separator + 2, -1);
      anchor.rel = "noreferrer";
      parent.append(anchor);
    }
    cursor = index + token.length;
  }
  if (cursor < source.length) parent.append(document.createTextNode(source.slice(cursor)));
}

function parseListLine(line) {
  const match = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
  if (!match) return null;
  return {
    indent: match[1].replaceAll("\t", "    ").length,
    ordered: /\d+\./.test(match[2]),
    content: match[3],
  };
}

function parseList(lines, startIndex, baseIndent) {
  const first = parseListLine(lines[startIndex] ?? "");
  if (!first || first.indent !== baseIndent) return null;
  const list = document.createElement(first.ordered ? "ol" : "ul");
  let index = startIndex;
  let lastItem = null;

  while (index < lines.length) {
    const item = parseListLine(lines[index] ?? "");
    if (!item || item.indent < baseIndent) break;
    if (item.indent > baseIndent) {
      if (!lastItem) break;
      const nested = parseList(lines, index, item.indent);
      if (!nested) break;
      lastItem.append(nested.list);
      index = nested.index;
      continue;
    }
    if (item.ordered !== first.ordered) break;

    lastItem = document.createElement("li");
    appendInlineMarkdown(lastItem, item.content);
    list.append(lastItem);
    index += 1;
  }

  return { list, index };
}

function isBlockStart(line) {
  return (
    /^#{1,3}\s/.test(line) ||
    parseListLine(line) !== null ||
    /^>\s?/.test(line) ||
    /^```/.test(line) ||
    /^---+$/.test(line.trim())
  );
}

function markdownToFragment(markdown) {
  const fragment = document.createDocumentFragment();
  const lines = normalizeMarkdown(markdown).split("\n");
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      const element = document.createElement(`h${heading[1].length}`);
      appendInlineMarkdown(element, heading[2]);
      fragment.append(element);
      index += 1;
      continue;
    }

    if (/^```/.test(line)) {
      const codeLines = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index] ?? "")) {
        codeLines.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = codeLines.join("\n");
      pre.append(code);
      fragment.append(pre);
      continue;
    }

    if (/^---+$/.test(line.trim())) {
      fragment.append(document.createElement("hr"));
      index += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoteLines = [];
      while (index < lines.length && /^>\s?/.test(lines[index] ?? "")) {
        quoteLines.push((lines[index] ?? "").replace(/^>\s?/, ""));
        index += 1;
      }
      const quote = document.createElement("blockquote");
      appendInlineMarkdown(quote, quoteLines.join(" "));
      fragment.append(quote);
      continue;
    }

    const listLine = parseListLine(line);
    if (listLine) {
      const parsedList = parseList(lines, index, listLine.indent);
      if (parsedList) {
        fragment.append(parsedList.list);
        index = parsedList.index;
        continue;
      }
    }

    const paragraphLines = [line];
    index += 1;
    while (
      index < lines.length &&
      (lines[index] ?? "").trim() &&
      !isBlockStart(lines[index] ?? "")
    ) {
      paragraphLines.push(lines[index] ?? "");
      index += 1;
    }
    const paragraph = document.createElement("p");
    appendInlineMarkdown(paragraph, paragraphLines.join(" "));
    fragment.append(paragraph);
  }

  if (!fragment.hasChildNodes()) {
    const paragraph = document.createElement("p");
    paragraph.append(document.createElement("br"));
    fragment.append(paragraph);
  }
  return fragment;
}

function inlineToMarkdown(node) {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? "").replaceAll("\u00a0", " ");
  if (!(node instanceof HTMLElement)) return "";
  const content = [...node.childNodes].map(inlineToMarkdown).join("");
  switch (node.tagName) {
    case "STRONG":
    case "B":
      return `**${content}**`;
    case "EM":
    case "I":
      return `*${content}*`;
    case "CODE":
      return `\`${content}\``;
    case "IMG": {
      const assetPath = node.dataset.assetPath;
      return assetPath ? `![${node.alt}](${assetPath})` : "";
    }
    case "A":
      return /^https?:\/\//.test(node.href) ? `[${content}](${node.href})` : content;
    case "BR":
      return "\n";
    default:
      return content;
  }
}

function listToMarkdown(list, indent = 0) {
  const lines = [];
  const items = [...list.children].filter((child) => child.tagName === "LI");
  for (const [index, item] of items.entries()) {
    const directContent = [...item.childNodes]
      .filter(
        (child) =>
          !(child instanceof HTMLElement && (child.tagName === "UL" || child.tagName === "OL")),
      )
      .map(inlineToMarkdown)
      .join("")
      .trim();
    const marker = list.tagName === "OL" ? `${index + 1}.` : "-";
    lines.push(`${" ".repeat(indent)}${marker} ${directContent}`);
    for (const child of item.children) {
      if (child.tagName === "UL" || child.tagName === "OL") {
        lines.push(listToMarkdown(child, indent + 3));
      }
    }
  }
  return lines.join("\n");
}

function blockToMarkdown(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent?.trim() ?? "";
  if (!(node instanceof HTMLElement)) return "";
  const content = inlineToMarkdown(node).trim();
  if (/^H[1-6]$/.test(node.tagName)) {
    return `${"#".repeat(Number(node.tagName.slice(1)))} ${content}`;
  }
  if (node.tagName === "UL" || node.tagName === "OL") return listToMarkdown(node);
  if (node.tagName === "BLOCKQUOTE") {
    return content
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
  }
  if (node.tagName === "PRE") return `\`\`\`\n${node.textContent ?? ""}\n\`\`\``;
  if (node.tagName === "HR") return "---";
  return content;
}

function editorMarkdown() {
  const blocks = [...editor.childNodes].map(blockToMarkdown).filter(Boolean);
  return normalizeMarkdown(blocks.join("\n\n"));
}

function placeCaretAtEnd() {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function applyDocument(documentValue, activity = "saved", label = "Saved") {
  const restoreFocus = document.activeElement === editor;
  editor.replaceChildren(markdownToFragment(documentValue.markdown));
  revision = documentValue.revision;
  cleanMarkdown = normalizeMarkdown(documentValue.markdown);
  dirty = false;
  pendingFileDocument = null;
  conflictPanel.hidden = true;
  if (restoreFocus) placeCaretAtEnd();
  markRevisionArrival(activity, label);
  const firstHeading = editor.querySelector("h1");
  const documentName = firstHeading?.textContent?.trim() || "Untitled";
  document.title = `${documentName} · The Doc`;
}

function showConflict(fileDocument) {
  pendingFileDocument = fileDocument;
  conflictPanel.hidden = false;
  setActivity("conflict", "Choose which version to keep");
}

async function fetchDocument() {
  const response = await fetch("/api/document", { cache: "no-store" });
  if (!response.ok) throw new Error(`Cannot read PROJECT.md (${response.status}).`);
  return response.json();
}

async function refreshFromFile() {
  const fileDocument = await fetchDocument();
  if (fileDocument.revision === revision) return;
  if (dirty) {
    showConflict(fileDocument);
    return;
  }
  applyDocument(fileDocument, "remote", "Agent revised PROJECT.md");
}

async function saveDocument() {
  if (saving) return;
  const markdown = editorMarkdown();
  if (!dirty || markdown === cleanMarkdown) {
    dirty = false;
    const knownRevision = revision;
    try {
      await refreshFromFile();
      if (revision === knownRevision) setActivity("saved", "Saved");
    } catch {
      setActivity("offline", "Cannot check PROJECT.md");
    }
    return;
  }

  saving = true;
  setActivity("saving", "Saving PROJECT.md");
  try {
    const response = await fetch("/api/document", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ markdown, revision }),
    });
    if (response.status === 409) {
      showConflict(await response.json());
      return;
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `Save failed (${response.status}).`);
    }

    const saved = await response.json();
    revision = saved.revision;
    cleanMarkdown = markdown;
    dirty = editorMarkdown() !== cleanMarkdown;
    if (dirty) {
      setActivity("dirty", "Unsaved changes");
    } else if (saved.changed) {
      markRevisionArrival("waiting", "Saved · waiting for the agent");
      if (waitingTimer) clearTimeout(waitingTimer);
      waitingTimer = setTimeout(() => {
        if (document.body.dataset.activity === "waiting") setActivity("saved", "Saved");
      }, 10_000);
    } else {
      setActivity("saved", "Saved");
    }
  } catch (error) {
    setActivity("error", error instanceof Error ? error.message : "Save failed");
  } finally {
    saving = false;
    if (queuedFileSignal) {
      queuedFileSignal = false;
      void refreshFromFile().catch(() => setActivity("offline", "File connection lost"));
    }
  }
}

function connectFileEvents() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}/live`);
  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type === "listeners") {
      renderListeners(message.listeners);
      return;
    }
    if (message.type !== "document_changed" || message.revision === revision) return;
    if (saving) {
      queuedFileSignal = true;
      return;
    }
    void refreshFromFile().catch(() => setActivity("offline", "File connection lost"));
  });
  socket.addEventListener("close", () => {
    markListenersOffline();
    if (!dirty && !pendingFileDocument) setActivity("offline", "Reconnecting to PROJECT.md");
    reconnectTimer = setTimeout(connectFileEvents, 1200);
  });
  socket.addEventListener("open", () => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    void refreshFromFile().catch(() => setActivity("offline", "File connection lost"));
  });
}

editor.addEventListener("input", () => {
  dirty = editorMarkdown() !== cleanMarkdown;
  if (dirty) setActivity("dirty", "Unsaved changes");
  else setActivity("saved", "Saved");
});

editor.addEventListener("paste", (event) => {
  event.preventDefault();
  const text = event.clipboardData?.getData("text/plain") ?? "";
  document.execCommand("insertText", false, text);
});

document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    void saveDocument();
  }
});

useFileButton.addEventListener("click", () => {
  if (pendingFileDocument) applyDocument(pendingFileDocument, "remote", "Using file version");
});

keepDraftButton.addEventListener("click", () => {
  if (!pendingFileDocument) return;
  revision = pendingFileDocument.revision;
  pendingFileDocument = null;
  conflictPanel.hidden = true;
  dirty = true;
  void saveDocument();
});

try {
  applyDocument(await fetchDocument());
  connectFileEvents();
} catch (error) {
  setActivity("error", error instanceof Error ? error.message : "Cannot open PROJECT.md");
}
