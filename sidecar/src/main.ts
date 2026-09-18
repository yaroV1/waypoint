import { createInterface } from 'node:readline';
import type { Command, ProviderId, Reply, RuntimeStatus } from './contract.ts';

function send(msg: Reply): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

// Stub until the adapters land (slices 2 and 3).
function probe(provider: ProviderId): RuntimeStatus {
  return {
    available: false,
    auth: { state: 'unknown' },
    models: [],
    traits:
      provider === 'codex'
        ? { userQuestions: 'plan-mode-experimental', readOnlyEnforcement: 'os-sandbox', effortScope: 'turn' }
        : { userQuestions: 'native', readOnlyEnforcement: 'permission-policy', effortScope: 'session' },
  };
}

function shutdown(reason: string): void {
  console.error(`sidecar: shutdown (${reason})`);
  // exit only after pending stdout writes are flushed
  process.stdout.write('', () => process.exit(0));
}

function handle(line: string): void {
  let msg: Command;
  try {
    msg = JSON.parse(line);
  } catch {
    console.error(`sidecar: not JSON: ${line}`);
    return;
  }
  switch (msg.cmd) {
    case 'probe':
      send({ id: msg.id, ok: true, result: probe(msg.provider) });
      break;
    case 'shutdown':
      send({ id: msg.id, ok: true, result: null });
      shutdown('shutdown cmd');
      break;
    default:
      send({ id: (msg as { id: number }).id, ok: false, error: `unknown cmd: ${(msg as { cmd: string }).cmd}` });
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', handle);
// stdin EOF is a shutdown too: covers a crashed or killed parent.
rl.on('close', () => shutdown('stdin EOF'));
