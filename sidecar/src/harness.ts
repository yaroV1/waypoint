// Terminal harness: drives the sidecar over the same JSONL wire protocol the Tauri shell uses.
//
//   node src/harness.ts <provider>                                 probe only, no model usage
//   node src/harness.ts <provider> <cwd> "<prompt>" [model] [effort]
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

function onEvent(e: AgentEvent): void {
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
    case 'turn.ended':
      println(`[turn.ended] ${e.outcome}${e.error ? `: ${e.error.message}` : ''}`);
      return turnEnded(e);
    default: {
      const { sessionId: _s, seq: _q, ts: _t, raw: _r, type, ...rest } = e;
      return println(`[${type}] ${JSON.stringify(rest)}`);
    }
  }
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
}

main().catch(async (e) => {
  println(`[harness] error: ${e instanceof Error ? e.message : e}`);
  child.stdin.end();
  await exited;
  process.exit(1);
});
