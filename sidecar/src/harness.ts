// Terminal harness: drives the sidecar over the same JSONL wire protocol the Tauri shell uses.
//
//   node src/harness.ts <provider>                                 probe only, no model usage
//   node src/harness.ts <provider> <cwd> "<prompt>" [model] [effort]
//
// Approval requests are answered from stdin: an option number or id per line
// (interactive, or scripted: `printf 'decline\n' | node src/harness.ts …`).
//
// WAYPOINT_RAW=1    print full event JSON (including `raw`)
// WAYPOINT_TRACE=1  sidecar logs provider wire traffic to stderr

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { AgentEvent, Command, EventMessage, ProviderId, Reply, RuntimeStatus } from './contract.ts';

const [provider, cwd, prompt, modelArg, effortArg] = process.argv.slice(2) as [ProviderId, ...string[]];
if (provider !== 'codex' && provider !== 'claude') {
  console.error('usage: node src/harness.ts <codex|claude> [<cwd> "<prompt>" [model] [effort]]');
  process.exit(2);
}

const child = spawn(process.execPath, [new URL('./main.ts', import.meta.url).pathname], {
  stdio: ['pipe', 'pipe', 'inherit'],
});
const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

let nextId = 1;
const pending = new Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();
function call<T>(cmd: DistributiveOmit<Command, 'id'>): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (r: unknown) => void, reject });
    child.stdin.write(JSON.stringify({ id, ...cmd }) + '\n');
  });
}

let midLine = false;
function println(s: string): void {
  if (midLine) process.stdout.write('\n');
  midLine = false;
  console.log(s);
}

let turnEnded: (e: Extract<AgentEvent, { type: 'turn.ended' }>) => void = () => {};

// stdin lines, queued so scripted answers can arrive before the request does
const answers: string[] = [];
let answerWaiter: { resolve: (line: string) => void; reject: (e: Error) => void } | null = null;
let stdinRl: ReturnType<typeof createInterface> | null = null;
let stdinClosed = false;
function readAnswer(): Promise<string> {
  stdinRl ??= createInterface({ input: process.stdin })
    .on('line', (line) => {
      if (answerWaiter) {
        answerWaiter.resolve(line);
        answerWaiter = null;
      } else answers.push(line);
    })
    .on('close', () => {
      stdinClosed = true;
      answerWaiter?.reject(new Error('stdin closed before the request was answered'));
    });
  const queued = answers.shift();
  if (queued !== undefined) return Promise.resolve(queued);
  if (stdinClosed) return Promise.reject(new Error('stdin closed before the request was answered'));
  return new Promise((resolve, reject) => (answerWaiter = { resolve, reject }));
}

async function answerRequest(e: Extract<AgentEvent, { type: 'request.opened' }>): Promise<void> {
  if (e.request.kind !== 'approval') return println(`[request.opened] ${e.request.kind} requests are not supported by the harness yet`);
  const { title, detail, options } = e.request;
  println(`[request.opened] ${title}${detail ? `\n  ${detail.replaceAll('\n', '\n  ')}` : ''}`);
  options.forEach((o, i) => println(`  ${i + 1}) ${o.id} — ${o.label} (${o.effect})`));
  for (;;) {
    const line = (await readAnswer()).trim();
    const option = options.find((o, i) => o.id === line || String(i + 1) === line);
    if (!option) {
      println(`  not an option: ${line}`);
      continue;
    }
    println(`  → ${option.id}`);
    await call({ cmd: 'request.respond', sessionId: e.sessionId, requestId: e.requestId, response: { optionId: option.id } });
    return;
  }
}

function printEvent(e: AgentEvent): void {
  if (process.env.WAYPOINT_RAW) return println(JSON.stringify(e));
  switch (e.type) {
    case 'message.delta':
      process.stdout.write(e.text);
      midLine = true;
      return;
    case 'message.completed':
      return println(`[message.completed] ${e.text.length} chars`);
    case 'activity':
      return println(`[activity ${e.phase}] ${e.kind}: ${e.title}${e.status ? ` (${e.status})` : ''}`);
    case 'request.opened':
      return; // printed by answerRequest
    case 'turn.ended':
      return println(`[turn.ended] ${e.outcome}${e.error ? `: ${e.error.message}` : ''}`);
    default: {
      const { sessionId: _s, seq: _q, ts: _t, raw: _r, type, ...rest } = e;
      return println(`[${type}] ${JSON.stringify(rest)}`);
    }
  }
}

function onEvent(e: AgentEvent): void {
  printEvent(e);
  if (e.type === 'request.opened') void answerRequest(e).catch(fail);
  if (e.type === 'turn.ended') turnEnded(e);
}

createInterface({ input: child.stdout }).on('line', (line) => {
  const msg = JSON.parse(line) as Reply | EventMessage;
  if ('event' in msg) return onEvent(msg.event);
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.ok) p.resolve(msg.result);
  else p.reject(new Error(msg.error));
});

async function main(): Promise<void> {
  const status = await call<RuntimeStatus>({ cmd: 'probe', provider });
  println(`[probe] available=${status.available} version=${status.version} auth=${status.auth.state}${status.auth.plan ? ` · ${status.auth.plan}` : ''}`);
  for (const m of status.models) {
    println(`  ${m.isDefault ? '*' : ' '} ${m.id}  efforts=${m.efforts.join(',')}  default=${m.defaultEffort}`);
  }
  println(`  traits=${JSON.stringify(status.traits)}`);

  if (cwd && prompt) {
    const model = modelArg ?? status.models.find((m) => m.isDefault)?.id;
    if (!model) throw new Error('no model given and the probe reported no default');
    const effort = effortArg ?? 'low';
    const { sessionId } = await call<{ sessionId: string }>({ cmd: 'session.open', provider, options: { cwd, model, effort } });
    const ended = new Promise((resolve) => (turnEnded = resolve));
    await call({ cmd: 'turn.start', sessionId, input: prompt });
    await ended;
    await call({ cmd: 'session.close', sessionId });
  }

  await call({ cmd: 'shutdown' });
  child.stdin.end();
  println(`[harness] sidecar exited with code ${await exited}`);
  stdinRl?.close();
}

async function fail(e: unknown): Promise<never> {
  println(`[harness] error: ${e instanceof Error ? e.message : e}`);
  child.stdin.end();
  await exited;
  process.exit(1);
}

main().catch(fail);
