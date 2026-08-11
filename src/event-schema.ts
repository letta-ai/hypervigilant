import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

export const FILE_EVENT_SCHEMA = "dev.hypervigilant.file-event@1" as const;
export const EVENT_RECEIPT_SCHEMA = "dev.hypervigilant.event-receipt@1" as const;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "Expected a lowercase SHA-256 hex digest.");
const relativePathSchema = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== ".."),
    "Expected a project-relative forward-slash path.",
  );
const emitterIdSchema = z
  .string()
  .regex(/^hvem_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

const fileVersionSchema = z
  .object({
    sha256: sha256Schema,
    bytes: z.number().int().min(0),
    kind: z.enum(["text", "binary"]),
    text: z.string().optional(),
  })
  .strict()
  .superRefine((version, context) => {
    if (version.kind === "text" && version.text === undefined) {
      context.addIssue({ code: "custom", path: ["text"], message: "Text versions require text." });
    }
    if (version.kind === "text" && version.text !== undefined) {
      const bytes = Buffer.from(version.text, "utf8");
      if (bytes.byteLength !== version.bytes) {
        context.addIssue({
          code: "custom",
          path: ["bytes"],
          message: "Text byte count does not match its UTF-8 content.",
        });
      }
      if (createHash("sha256").update(bytes).digest("hex") !== version.sha256) {
        context.addIssue({
          code: "custom",
          path: ["sha256"],
          message: "Text digest does not match its UTF-8 content.",
        });
      }
    }
    if (version.kind === "binary" && version.text !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["text"],
        message: "Binary versions cannot contain text.",
      });
    }
  });

export const fileEventChangeSchema = z
  .object({
    path: relativePathSchema,
    event: z.enum(["add", "change", "delete"]),
    before: fileVersionSchema.nullable(),
    after: fileVersionSchema.nullable(),
  })
  .strict()
  .superRefine((change, context) => {
    if (change.event === "add" && (change.before !== null || change.after === null)) {
      context.addIssue({
        code: "custom",
        message: "Add events require null before and non-null after.",
      });
    }
    if (change.event === "change" && (change.before === null || change.after === null)) {
      context.addIssue({
        code: "custom",
        message: "Change events require non-null before and after.",
      });
    }
    if (change.event === "delete" && (change.before === null || change.after !== null)) {
      context.addIssue({
        code: "custom",
        message: "Delete events require non-null before and null after.",
      });
    }
  });

export const fileEventPayloadSchema = z
  .object({
    schema: z.literal(FILE_EVENT_SCHEMA),
    eventId: z.string().regex(/^hvevt_[0-9a-f]{64}$/),
    emitterId: emitterIdSchema,
    sequence: z.number().int().min(1),
    project: z.string().min(1),
    observedAt: z.iso.datetime(),
    changes: z.array(fileEventChangeSchema).min(1),
  })
  .strict()
  .superRefine((payload, context) => {
    const paths = new Set<string>();
    let previousPath = "";
    for (const [index, change] of payload.changes.entries()) {
      if (paths.has(change.path)) {
        context.addIssue({
          code: "custom",
          path: ["changes", index, "path"],
          message: `Duplicate changed path ${JSON.stringify(change.path)}.`,
        });
      }
      if (previousPath && previousPath.localeCompare(change.path) > 0) {
        context.addIssue({
          code: "custom",
          path: ["changes", index, "path"],
          message: "Changed paths must be sorted.",
        });
      }
      paths.add(change.path);
      previousPath = change.path;
    }
  });

export const eventReceiptSchema = z
  .object({
    schema: z.literal(EVENT_RECEIPT_SCHEMA),
    accepted: z.literal(true),
    eventId: z.string().regex(/^hvevt_[0-9a-f]{64}$/),
    bodySha256: sha256Schema,
    sourceId: z.string().min(1).max(256),
    sourceSequence: z.number().int().min(0),
    acceptedAt: z.iso.datetime(),
  })
  .strict();

export const pendingHttpDestinationSchema = z
  .object({
    url: z.string().url(),
    authTokenEnv: z.string().optional(),
    requestTimeoutMs: z.number().int().min(1),
  })
  .strict();

export const pendingAgentDestinationSchema = z
  .object({
    agentId: z.string().min(1),
    connectionKey: z.string().min(1),
  })
  .strict();

export function hashEventBody(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export const pendingEventSchema = z
  .object({
    eventId: z.string().regex(/^hvevt_[0-9a-f]{64}$/),
    sequence: z.number().int().min(1),
    body: z.string().min(1),
    bodySha256: sha256Schema,
    createdAt: z.iso.datetime(),
    httpDestination: pendingHttpDestinationSchema.optional(),
    httpReceipt: eventReceiptSchema.optional(),
    agentDestination: pendingAgentDestinationSchema.optional(),
    agentDeliveredPaths: z.array(relativePathSchema).default([]),
    agentMutationPaths: z.array(relativePathSchema).default([]),
    agentDelivered: z.boolean().default(false),
  })
  .strict()
  .superRefine((pending, context) => {
    let payload: FileEventPayload | null = null;
    try {
      payload = fileEventPayloadSchema.parse(JSON.parse(pending.body));
    } catch {
      context.addIssue({ code: "custom", path: ["body"], message: "Event body is invalid." });
    }
    if (payload && payload.eventId !== pending.eventId) {
      context.addIssue({
        code: "custom",
        path: ["eventId"],
        message: "Pending event ID does not match its body.",
      });
    }
    if (payload && payload.sequence !== pending.sequence) {
      context.addIssue({
        code: "custom",
        path: ["sequence"],
        message: "Pending sequence does not match its body.",
      });
    }
    if (hashEventBody(pending.body) !== pending.bodySha256) {
      context.addIssue({
        code: "custom",
        path: ["bodySha256"],
        message: "Pending body digest does not match its body.",
      });
    }
    if (!pending.httpDestination && !pending.agentDestination) {
      context.addIssue({ code: "custom", message: "Pending event has no destination lease." });
    }
    if (pending.httpReceipt && !pending.httpDestination) {
      context.addIssue({
        code: "custom",
        path: ["httpReceipt"],
        message: "HTTP receipt requires an HTTP destination lease.",
      });
    }
    if (
      pending.httpReceipt?.eventId !== undefined &&
      pending.httpReceipt.eventId !== pending.eventId
    ) {
      context.addIssue({
        code: "custom",
        path: ["httpReceipt", "eventId"],
        message: "HTTP receipt event ID does not match the pending event.",
      });
    }
    if (
      pending.httpReceipt?.bodySha256 !== undefined &&
      pending.httpReceipt.bodySha256 !== pending.bodySha256
    ) {
      context.addIssue({
        code: "custom",
        path: ["httpReceipt", "bodySha256"],
        message: "HTTP receipt body digest does not match the pending event.",
      });
    }
    if (pending.agentDelivered && !pending.agentDestination) {
      context.addIssue({
        code: "custom",
        path: ["agentDelivered"],
        message: "Agent delivery marker requires an agent destination lease.",
      });
    }
    const payloadPaths = new Set(payload?.changes.map((change) => change.path) ?? []);
    const deliveredPaths = new Set<string>();
    for (const [index, path] of pending.agentDeliveredPaths.entries()) {
      if (!payloadPaths.has(path)) {
        context.addIssue({
          code: "custom",
          path: ["agentDeliveredPaths", index],
          message: "Agent-delivered path is not part of the pending event.",
        });
      }
      if (deliveredPaths.has(path)) {
        context.addIssue({
          code: "custom",
          path: ["agentDeliveredPaths", index],
          message: "Agent-delivered path is duplicated.",
        });
      }
      deliveredPaths.add(path);
    }
    const mutationPaths = new Set<string>();
    for (const [index, path] of pending.agentMutationPaths.entries()) {
      if (mutationPaths.has(path)) {
        context.addIssue({
          code: "custom",
          path: ["agentMutationPaths", index],
          message: "Agent mutation path is duplicated.",
        });
      }
      mutationPaths.add(path);
    }
    if (pending.agentDelivered && deliveredPaths.size !== payloadPaths.size) {
      context.addIssue({
        code: "custom",
        path: ["agentDelivered"],
        message: "Completed agent delivery must include every pending path.",
      });
    }
  });

export const eventOutputStateSchema = z
  .object({
    emitterId: emitterIdSchema,
    nextSequence: z.number().int().min(1).default(1),
    pending: pendingEventSchema.optional(),
    lastReceipt: eventReceiptSchema.optional(),
  })
  .strict();

export type FileEventChange = z.infer<typeof fileEventChangeSchema>;
export type FileEventPayload = z.infer<typeof fileEventPayloadSchema>;
export type EventReceipt = z.infer<typeof eventReceiptSchema>;
export type PendingHttpDestination = z.infer<typeof pendingHttpDestinationSchema>;
export type PendingEvent = z.infer<typeof pendingEventSchema>;
export type EventOutputState = z.infer<typeof eventOutputStateSchema>;

export function createEmitterId(): string {
  return `hvem_${randomUUID()}`;
}

export function createEventId(emitterId: string, sequence: number): string {
  const digest = createHash("sha256").update(`${emitterId}\0${sequence}`, "utf8").digest("hex");
  return `hvevt_${digest}`;
}

export function parsePendingPayload(pending: PendingEvent): FileEventPayload {
  return fileEventPayloadSchema.parse(JSON.parse(pending.body));
}
