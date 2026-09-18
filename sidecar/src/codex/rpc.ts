import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { RequestId } from './generated/RequestId.ts';

// JSONL JSON-RPC client for `codex app-server` over stdio. The `jsonrpc` field is omitted on the wire.

const EXIT_GRACE_MS = 2000;

export interface RpcHandlers {
  onNotification(method: string, params: unknown, raw: unknown): void;
  onServerRequest(id: RequestId, method: string, params: unknown, raw: unknown): void;
  onExit(code: number | null): void;
}

type Pending = { resolve: (result: unknown) => void; reject: (e: Error) => void };

export class CodexRpc {
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, Pending>();
  private readonly exited: Promise<void>;
  private nextId = 1;
  private dead = false;

  constructor(handlers: RpcHandlers) {
    this.child = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'inherit'] });

    this.exited = new Promise((resolve) => {
      const onGone = (code: number | null, reason: string) => {
        if (this.dead) return;
        this.dead = true;
        for (const p of this.pending.values()) p.reject(new Error(`codex app-server ${reason}`));
        this.pending.clear();
        handlers.onExit(code);
        resolve();
      };
      this.child.on('exit', (code, signal) => onGone(code, `exited (code ${code}, signal ${signal})`));
      this.child.on('error', (e) => onGone(null, `failed to start: ${e.message}`));
    });
    // writes after the child is gone surface via 'exit'; don't crash on EPIPE
    this.child.stdin!.on('error', () => {});

    createInterface({ input: this.child.stdout! }).on('line', (line) => {
      if (process.env.WAYPOINT_TRACE) console.error(`codex ← ${line}`);
      let msg: { id?: RequestId; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } };
      try {
        msg = JSON.parse(line);
      } catch {
        console.error(`codex: not JSON: ${line}`);
        return;
      }
      if (msg.method !== undefined && msg.id !== undefined) {
        handlers.onServerRequest(msg.id, msg.method, msg.params, msg);
      } else if (msg.method !== undefined) {
        handlers.onNotification(msg.method, msg.params, msg);
      } else if (typeof msg.id === 'number') {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
    });
  }

  private write(msg: unknown): void {
    const line = JSON.stringify(msg);
    if (process.env.WAYPOINT_TRACE) console.error(`codex → ${line}`);
    this.child.stdin!.write(line + '\n');
  }

  request<T>(method: string, params: unknown): Promise<T> {
    if (this.dead) return Promise.reject(new Error('codex app-server is not running'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (r: unknown) => void, reject });
      this.write({ id, method, params });
    });
  }

  notify(method: string): void {
    this.write({ method });
  }

  respond(id: RequestId, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: RequestId, message: string): void {
    this.write({ id, error: { code: -32000, message } });
  }

  // app-server exits on stdin EOF; SIGKILL after a grace period.
  async close(): Promise<void> {
    if (this.dead) return;
    this.child.stdin!.end();
    const timer = setTimeout(() => this.child.kill('SIGKILL'), EXIT_GRACE_MS);
    await this.exited;
    clearTimeout(timer);
  }
}
