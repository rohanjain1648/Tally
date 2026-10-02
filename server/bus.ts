import { EventEmitter } from "node:events";

/** App-wide event bus. `ui` events fan out to browsers over SSE. */
export const bus = new EventEmitter();
bus.setMaxListeners(100);

export type UiEvent =
  | { type: "approvals_changed" }
  | { type: "invoices_changed" }
  | { type: "audit_changed" }
  | { type: "toast"; tone: "success" | "info" | "warning"; title: string; body?: string };

export const emitUi = (e: UiEvent) => bus.emit("ui", e);
