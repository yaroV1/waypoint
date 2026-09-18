import { createInterface } from 'node:readline';
import { ClaudeRuntime } from './claude/runtime.ts';
import { CodexRuntime } from './codex/runtime.ts';
import type { AgentRuntime, AgentSession, Command, EventMessage, ProviderId, Reply } from './contract.ts';

function send(msg: Reply | EventMessage): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

const runtimes: Record<ProviderId, AgentRuntime> = {
  codex: new CodexRuntime(),
  claude: new ClaudeRuntime(),
};
const sessions = new Map<string, AgentSession>();

function session(id: string): AgentSession {
  const s = sessions.get(id);
  if (!s) throw new Error(`unknown session: ${id}`);
  return s;
}

const inflight = new Set<Promise<void>>();
let shuttingDown = false;
async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`sidecar: shutdown (${reason})`);
  // let commands that are already running reply first (e.g. `echo '{…probe…}' | node main.ts`)
  await Promise.allSettled([...inflight]);
  await Promise.allSettled(Object.values(runtimes).map((r) => r.dispose()));
  // exit only after pending stdout writes are flushed
  process.stdout.write('', () => process.exit(0));
}

async function run(msg: Command): Promise<unknown> {
  switch (msg.cmd) {
    case 'probe':
      return runtimes[msg.provider].probe();
    case 'session.open': {
      const s = await runtimes[msg.provider].openSession(msg.options, (event) => {
        if (event.type === 'session.closed') sessions.delete(event.sessionId);
        send({ event });
      });
      sessions.set(s.id, s);
      return { sessionId: s.id, providerRef: s.providerRef };
    }
    case 'turn.start':
      return session(msg.sessionId).startTurn(msg.input);
    case 'request.respond':
      await session(msg.sessionId).respond(msg.requestId, msg.response);
      return null;
    case 'turn.interrupt':
      await session(msg.sessionId).interrupt();
      return null;
    case 'session.close':
      await session(msg.sessionId).close();
      return null;
    case 'shutdown':
      return null;
    default:
      throw new Error(`unknown cmd: ${(msg as { cmd: string }).cmd}`);
  }
}

function handle(line: string): void {
  let msg: Command;
  try {
    msg = JSON.parse(line);
  } catch {
    console.error(`sidecar: not JSON: ${line}`);
    return;
  }
  const done = run(msg).then(
    (result) => {
      send({ id: msg.id, ok: true, result: result ?? null });
      if (msg.cmd === 'shutdown') void shutdown('shutdown cmd');
    },
    (e: unknown) => send({ id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) }),
  );
  inflight.add(done);
  void done.then(() => inflight.delete(done));
}

const rl = createInterface({ input: process.stdin });
rl.on('line', handle);
// stdin EOF is a shutdown too: covers a crashed or killed parent.
rl.on('close', () => void shutdown('stdin EOF'));
