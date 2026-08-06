export const LISTENER_STATES = [
  "starting",
  "listening",
  "receiving",
  "working",
  "finished",
  "failed",
  "offline",
] as const;

export type ListenerState = (typeof LISTENER_STATES)[number];

export type ListenerEvent = {
  state: ListenerState;
  summary: string;
  at: string;
};

export type ListenerSnapshot = {
  id: string;
  label: string;
  kind: string;
  target: string;
  state: ListenerState;
  summary: string;
  updatedAt: string;
  events: ListenerEvent[];
};

export type ListenerSeed = Pick<ListenerSnapshot, "id" | "label" | "kind" | "target"> & {
  state?: ListenerState;
  summary?: string;
};

export type ListenerTransition = {
  state: ListenerState;
  summary: string;
  event?: string;
  settlesToListening?: boolean;
};

type Subscriber = (listeners: ListenerSnapshot[]) => void;

const MAX_EVENTS = 12;
const MAX_TEXT_LENGTH = 160;

function safeText(value: string, fallback: string): string {
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return (text || fallback).slice(0, MAX_TEXT_LENGTH);
}

function copyListener(listener: ListenerSnapshot): ListenerSnapshot {
  return { ...listener, events: listener.events.map((event) => ({ ...event })) };
}

export class ActivityFeed {
  readonly #listeners = new Map<string, ListenerSnapshot>();
  readonly #subscribers = new Set<Subscriber>();

  upsert(seed: ListenerSeed): ListenerSnapshot {
    const current = this.#listeners.get(seed.id);
    const now = new Date().toISOString();
    const state = seed.state ?? current?.state ?? "starting";
    const summary = safeText(seed.summary ?? current?.summary ?? "Starting", "Starting");
    const listener: ListenerSnapshot = {
      id: safeText(seed.id, "listener"),
      label: safeText(seed.label, "Listener"),
      kind: safeText(seed.kind, "Process"),
      target: safeText(seed.target, "PROJECT.md"),
      state,
      summary,
      updatedAt: now,
      events: current?.events ?? [],
    };
    this.#listeners.set(listener.id, listener);
    this.#publish();
    return copyListener(listener);
  }

  update(id: string, transition: ListenerTransition): ListenerSnapshot {
    const current = this.#listeners.get(id);
    if (!current) throw new Error(`Unknown listener: ${id}`);
    const now = new Date().toISOString();
    const summary = safeText(transition.summary, "Status changed");
    const eventSummary = transition.event ? safeText(transition.event, summary) : null;
    const events = eventSummary
      ? [...current.events, { state: transition.state, summary: eventSummary, at: now }].slice(-MAX_EVENTS)
      : current.events;
    const listener: ListenerSnapshot = {
      ...current,
      state: transition.state,
      summary,
      updatedAt: now,
      events,
    };
    this.#listeners.set(id, listener);
    this.#publish();
    return copyListener(listener);
  }

  snapshot(): ListenerSnapshot[] {
    return [...this.#listeners.values()]
      .sort((left, right) => left.label.localeCompare(right.label))
      .map(copyListener);
  }

  subscribe(subscriber: Subscriber): () => void {
    this.#subscribers.add(subscriber);
    return () => this.#subscribers.delete(subscriber);
  }

  #publish(): void {
    const snapshot = this.snapshot();
    for (const subscriber of this.#subscribers) subscriber(snapshot);
  }
}

export function parseHypervigilantActivity(line: string): ListenerTransition | null {
  const marker = "[hypervigilant] ";
  const markerIndex = line.lastIndexOf(marker);
  if (markerIndex < 0) return null;
  const status = line.slice(markerIndex + marker.length).trim();

  if (status.startsWith("ERROR:") || /Delivery (?:failed|stopped)/i.test(status)) {
    return {
      state: "failed",
      summary: "The last delivery failed. Check the terminal.",
      event: "Delivery failed",
    };
  }
  if (status.startsWith("Sending ")) {
    const count = status.match(/^Sending (\d+)/)?.[1] ?? "a";
    return {
      state: "receiving",
      summary: "Reading the saved document diff",
      event: `Received ${count} saved change${count === "1" ? "" : "s"}`,
    };
  }
  if (/YOLO auto-approved (?:Edit|Write):/.test(status)) {
    return {
      state: "working",
      summary: "Revising PROJECT.md",
      event: "Started a guarded document edit",
    };
  }
  if (status === "Delivery complete.") {
    return {
      state: "finished",
      summary: "Finished the document revision",
      event: "Finished the document revision",
      settlesToListening: true,
    };
  }
  if (status.startsWith("Watching ")) {
    return {
      state: "listening",
      summary: "Waiting for a saved change",
      event: "Listener connected",
    };
  }
  if (status.startsWith("First run:") || status.startsWith("Baseline established.")) {
    return {
      state: "starting",
      summary: "Preparing the document baseline",
    };
  }
  return null;
}
