import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

export type RuntimeMode = "development" | "production";
export interface Response {
  status: number;
  body: unknown;
}

interface ErrorBody {
  code: string;
  message: string;
  requestId: string;
  internalMessage?: string;
  stack?: string;
  cause?: unknown;
}

export interface AuditInput {
  actorId: string;
  tenantId: string;
  action: string;
  objectId: string;
}

export interface AuditEvent extends AuditInput {
  eventId: string;
  timestamp: string;
}

function environmentMode(): RuntimeMode {
  return process.env.NODE_ENV === "development" ? "development" : "production";
}

let runtimeMode: RuntimeMode = environmentMode();

/** Set process-wide response presentation during application bootstrap. */
export function configureRuntime(mode: RuntimeMode): void {
  if (mode !== "development" && mode !== "production") {
    throw new TypeError("Unsupported runtime mode");
  }
  runtimeMode = mode;
}

/** Report the active response presentation mode. */
export function getRuntimeMode(): RuntimeMode {
  return runtimeMode;
}

/** Shape an error body for the active presentation mode. */
function presentable(body: ErrorBody): ErrorBody {
  if (runtimeMode === "development") return body;
  const { code, message, requestId } = body;
  return { code, message, requestId };
}

/** Base class for deliberately public request errors. */
export class PublicError extends Error {
  readonly status: number;
  readonly code: string;
  readonly publicMessage: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "PublicError";
    this.status = status;
    this.code = code;
    this.publicMessage = message;
  }
}

/** Reject a malformed field without including the submitted value. */
export class BadInput extends PublicError {
  constructor(message = "Invalid request") {
    super(400, "BAD_INPUT", message);
    this.name = "BadInput";
  }
}

/** Reject a principal that cannot perform the operation. */
export class Forbidden extends PublicError {
  constructor() {
    super(403, "FORBIDDEN", "Operation not permitted");
    this.name = "Forbidden";
  }
}

/** Represent absent workspace resources. */
export class NotFound extends PublicError {
  constructor(message = "Resource not found") {
    super(404, "NOT_FOUND", message);
    this.name = "NotFound";
  }
}

/** Reject a valid request incompatible with the ledger state. */
export class Conflict extends PublicError {
  constructor(message = "Operation conflicts with current state") {
    super(409, "CONFLICT", message);
    this.name = "Conflict";
  }
}

/** Translate thrown values into transport-neutral responses. */
export function respond(error: unknown): Response {
  const requestId = randomUUID();
  const known = error instanceof PublicError;
  const status = known ? error.status : 500;
  const body: ErrorBody = {
    code: known ? error.code : "INTERNAL",
    message: known ? error.publicMessage : "Unable to complete request",
    requestId,
    internalMessage: error instanceof Error ? error.message : "Non-error thrown",
    stack: error instanceof Error ? error.stack : undefined,
    cause: error instanceof Error ? error.cause : undefined,
  };
  return { status, body: presentable(body) };
}

type Subscriber = (event: Readonly<AuditEvent>) => void;

/** Bounded process-local event history with best-effort subscribers. */
export class AuditBus {
  private emitter = new EventEmitter();
  private history: Readonly<AuditEvent>[] = [];
  private capacity = 500;

  /** Emit an immutable event after a successful operation. */
  emitEvent(input: AuditInput): void {
    const event: Readonly<AuditEvent> = Object.freeze({
      actorId: input.actorId,
      tenantId: input.tenantId,
      action: input.action,
      objectId: input.objectId,
      eventId: randomUUID(),
      timestamp: new Date().toISOString(),
    });
    this.history.push(event);
    if (this.history.length > this.capacity) this.history.shift();
    this.emitter.emit("audit", event);
  }

  /** Attach an observer; observer failures do not roll back ledger operations. */
  subscribe(subscriber: Subscriber): () => void {
    const listener = (event: Readonly<AuditEvent>): void => {
      try {
        subscriber(event);
      } catch {
        // The local history remains available if a downstream sink is offline.
      }
    };
    this.emitter.on("audit", listener);
    return () => {
      this.emitter.off("audit", listener);
    };
  }

  /** Return detached event records for diagnostics. */
  recent(): AuditEvent[] {
    return this.history.map(event => ({ ...event }));
  }
}

// TODO: expose a batch-drain adapter for the marina operations console.
export const audit = new AuditBus();
