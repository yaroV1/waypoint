import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AgentEvent, Command, EventMessage, Reply } from "../sidecar/src/contract.ts";

// Client for the sidecar wire protocol; Rust relays the JSONL lines verbatim.

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

let nextId = 1;
const pending = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();
const eventListeners = new Set<(e: AgentEvent) => void>();
const exitListeners = new Set<(code: number | null) => void>();

const unlisten = [
  listen<string>("sidecar-line", ({ payload }) => {
    const msg = JSON.parse(payload) as Reply | EventMessage;
    if ("event" in msg) {
      eventListeners.forEach((fn) => fn(msg.event));
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error));
  }),
  listen<{ code: number | null }>("sidecar-exit", ({ payload }) => {
    pending.forEach((p) => p.reject(new Error("sidecar exited")));
    pending.clear();
    exitListeners.forEach((fn) => fn(payload.code));
  }),
];
import.meta.hot?.dispose(() => unlisten.forEach((p) => p.then((f) => f())));

export function call<T>(cmd: DistributiveOmit<Command, "id">): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (r: unknown) => void, reject });
    invoke("sidecar_send", { line: JSON.stringify({ id, ...cmd }) }).catch((e) => {
      pending.delete(id);
      reject(new Error(String(e)));
    });
  });
}

export function onAgentEvent(fn: (e: AgentEvent) => void): () => void {
  eventListeners.add(fn);
  return () => eventListeners.delete(fn);
}

export function onSidecarExit(fn: (code: number | null) => void): () => void {
  exitListeners.add(fn);
  return () => exitListeners.delete(fn);
}
