import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { AccountInfo, CanUseTool, EffortLevel, Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentEvent,
  AgentRuntime,
  AgentSession,
  InteractionResponse,
  RuntimeStatus,
  SessionOptions,
} from '../contract.ts';

// distributive Omit, so the AgentEvent union survives
type EventBody = AgentEvent extends infer E ? (E extends AgentEvent ? Omit<E, 'sessionId' | 'seq' | 'ts'> : never) : never;
type ActivityFields = Pick<Extract<AgentEvent, { type: 'activity' }>, 'kind' | 'title'>;

// Billing gate (design D + Deviations 1): these select API-key billing over the subscription.
const BILLING_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

function billingVarsPresent(): boolean {
  return BILLING_VARS.some((k) => process.env[k] !== undefined);
}

// SDK `env` replaces the child environment entirely
function childEnv(): Record<string, string | undefined> {
  const env = { ...process.env };
  for (const k of BILLING_VARS) delete env[k];
  return env;
}

// decision J5: the installed `claude` from PATH, not the SDK-bundled binary
function resolveClaude(): string {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(dir, 'claude');
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  throw new Error('claude not found in PATH');
}

// `claude --version` prints "2.1.277 (Claude Code)"
function claudeVersion(path: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(path, ['--version'], { env: childEnv() }, (err, stdout) => resolve(err ? undefined : /^(\S+)/.exec(stdout)?.[1]));
  });
}

function authState(a: AccountInfo): RuntimeStatus['auth'] {
  if (a.apiKeySource) return { state: 'api-key' };
  if (a.apiProvider === 'firstParty' && a.subscriptionType) return { state: 'subscription', plan: a.subscriptionType };
  return { state: 'unknown' };
}

function describeTool(name: string, input: unknown): ActivityFields {
  const i = (input ?? {}) as Record<string, unknown>;
  if (name === 'Bash') return { kind: 'command', title: String(i.command ?? name) };
  if (name === 'Write' || name === 'Edit' || name === 'NotebookEdit') return { kind: 'fileChange', title: `${name} ${String(i.file_path ?? i.notebook_path ?? '')}` };
  if (name.startsWith('mcp__')) return { kind: 'mcpTool', title: name };
  const arg = i.file_path ?? i.pattern ?? i.path ?? i.url ?? i.query;
  return { kind: 'other', title: arg === undefined ? name : `${name} ${String(arg)}` };
}

// Streaming input for query(): user messages are pushed one per turn.
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private readonly items: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private ended = false;

  push(m: SDKUserMessage): void {
    this.items.push(m);
    this.wake?.();
  }

  end(): void {
    this.ended = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.items.length) yield this.items.shift()!;
      if (this.ended) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = null;
    }
  }
}

class ClaudeSession implements AgentSession {
  readonly id = randomUUID();
  readonly providerRef: { provider: 'claude'; nativeId: string };
  private readonly input = new InputQueue();
  private readonly q: Query;
  private readonly onEvent: (e: AgentEvent) => void;
  private readonly onClosed: () => void;
  private readonly tools = new Map<string, ActivityFields>(); // by tool_use id
  private readonly denied = new Set<string>(); // tool_use ids
  private seq = 0;
  private turnActive = false;
  private turnId: string | null = null;
  private streamItemId: string | null = null;
  private interruptRequested = false;
  private closing = false;

  constructor(options: Options, onEvent: (e: AgentEvent) => void, onClosed: () => void) {
    const nativeId = randomUUID();
    this.providerRef = { provider: 'claude', nativeId };
    this.onEvent = onEvent;
    this.onClosed = onClosed;
    this.q = query({ prompt: this.input, options: { ...options, sessionId: nativeId, canUseTool: this.canUseTool } });
    void this.consume();
  }

  emit(body: EventBody): void {
    this.onEvent({ sessionId: this.id, seq: this.seq++, ts: Date.now(), ...body } as AgentEvent);
  }

  accountInfo(): Promise<AccountInfo> {
    return this.q.accountInfo();
  }

  // Slice 3: no interaction UI yet. Deny whatever asks; the turn continues.
  private readonly canUseTool: CanUseTool = async (toolName, _input, { toolUseID }) => {
    this.denied.add(toolUseID);
    this.emit({ type: 'notice', level: 'warning', message: `${toolName} denied (approvals and questions are not implemented yet)` });
    return { behavior: 'deny', message: 'This session is read-only and cannot ask for approval yet; the tool call was not approved.' };
  };

  async startTurn(input: string): Promise<{ turnId: string }> {
    if (this.turnActive) throw new Error('a turn is already active');
    const turnId = randomUUID();
    this.turnActive = true;
    this.turnId = turnId;
    this.interruptRequested = false;
    this.emit({ type: 'turn.started', turnId });
    this.input.push({ type: 'user', message: { role: 'user', content: input }, parent_tool_use_id: null });
    return { turnId };
  }

  async respond(_requestId: string, _r: InteractionResponse): Promise<void> {
    throw new Error('approvals and questions are not implemented yet (slices 4-5)');
  }

  async interrupt(): Promise<void> {
    if (!this.turnActive) return;
    // the SDK reports an interrupt as `error_during_execution`; remember that we asked for it
    this.interruptRequested = true;
    await this.q.interrupt();
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.q.close();
    this.input.end();
    this.onClosed();
    this.emit({ type: 'session.closed', reason: 'requested' });
  }

  private async consume(): Promise<void> {
    let error: string | undefined;
    try {
      for await (const m of this.q) {
        if (process.env.WAYPOINT_TRACE) console.error(`claude ← ${JSON.stringify(m)}`);
        this.handleMessage(m);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    if (!this.closing) this.handleProcessExit(error);
  }

  private handleMessage(m: SDKMessage): void {
    const turnId = this.turnId;
    if (!turnId) return;
    switch (m.type) {
      case 'stream_event': {
        if (m.parent_tool_use_id !== null) break;
        if (m.event.type === 'message_start') this.streamItemId = m.event.message.id;
        if (m.event.type === 'content_block_delta' && m.event.delta.type === 'text_delta' && this.streamItemId) {
          this.emit({ type: 'message.delta', turnId, itemId: this.streamItemId, text: m.event.delta.text, raw: m });
        }
        break;
      }
      case 'assistant': {
        if (m.parent_tool_use_id !== null) break;
        for (const block of m.message.content) {
          if (block.type === 'text') {
            this.emit({ type: 'message.completed', turnId, itemId: m.message.id, text: block.text, raw: m });
          } else if (block.type === 'tool_use') {
            const fields = describeTool(block.name, block.input);
            this.tools.set(block.id, fields);
            this.emit({ type: 'activity', turnId, itemId: block.id, phase: 'started', ...fields, raw: m });
          }
        }
        break;
      }
      case 'user': {
        if (m.parent_tool_use_id !== null || typeof m.message.content === 'string') break;
        for (const block of m.message.content) {
          if (block.type !== 'tool_result') continue;
          const fields = this.tools.get(block.tool_use_id);
          if (!fields) continue;
          this.tools.delete(block.tool_use_id);
          const status = this.denied.delete(block.tool_use_id) ? 'declined' : block.is_error ? 'failed' : 'ok';
          this.emit({ type: 'activity', turnId, itemId: block.tool_use_id, phase: 'completed', ...fields, status, raw: m });
        }
        break;
      }
      case 'system': {
        if (m.subtype === 'api_retry') {
          this.emit({ type: 'notice', level: 'warning', message: `API retry ${m.attempt}/${m.max_retries}: ${m.error}`, raw: m });
        }
        break;
      }
      case 'result': {
        this.turnActive = false;
        this.turnId = null;
        this.streamItemId = null;
        if (this.interruptRequested) {
          this.emit({ type: 'turn.ended', turnId, outcome: 'interrupted', raw: m });
        } else if (m.subtype === 'success' && !m.is_error) {
          this.emit({ type: 'turn.ended', turnId, outcome: 'completed', raw: m });
        } else {
          const message = m.subtype === 'success' ? m.result : m.errors.join('; ') || m.subtype;
          this.emit({ type: 'turn.ended', turnId, outcome: 'failed', error: { message }, raw: m });
        }
        break;
      }
    }
  }

  // the message stream ended although nobody asked for close(): the CLI is gone
  private handleProcessExit(error: string | undefined): void {
    this.closing = true;
    if (this.turnActive && this.turnId) {
      this.emit({ type: 'turn.ended', turnId: this.turnId, outcome: 'failed', error: { message: error ?? 'claude exited' } });
    }
    this.turnActive = false;
    this.onClosed();
    this.emit({ type: 'session.closed', reason: 'process-exit' });
  }
}

export class ClaudeRuntime implements AgentRuntime {
  readonly provider = 'claude';
  private readonly sessions = new Set<ClaudeSession>();
  private models: RuntimeStatus['models'] | null = null;

  // A query whose input never yields: control requests work, no model usage.
  async probe(): Promise<RuntimeStatus> {
    const traits: RuntimeStatus['traits'] = {
      userQuestions: 'native',
      readOnlyEnforcement: 'permission-policy',
      effortScope: 'session',
    };
    // refuse without starting the CLI
    if (billingVarsPresent()) return { available: false, auth: { state: 'api-key' }, models: [], traits };

    let q: Query | undefined;
    try {
      const path = resolveClaude();
      q = query({
        prompt: new InputQueue(),
        // tmpdir: the user's MCP servers start even for a probe and may write into the cwd
        options: { pathToClaudeCodeExecutable: path, env: childEnv(), cwd: tmpdir(), persistSession: false },
      });
      const [account, infos, version] = await Promise.all([q.accountInfo(), q.supportedModels(), claudeVersion(path)]);
      const models = infos.map((m) => ({
        id: m.value,
        displayName: m.displayName,
        isDefault: m.value === 'default',
        efforts: m.supportedEffortLevels ?? [],
      }));
      this.models = models;
      return { available: true, version, auth: authState(account), models, traits };
    } catch {
      return { available: false, auth: { state: 'unknown' }, models: [], traits };
    } finally {
      q?.close();
    }
  }

  async openSession(o: SessionOptions, onEvent: (e: AgentEvent) => void): Promise<AgentSession> {
    if (billingVarsPresent()) {
      throw new Error(`${BILLING_VARS.join(' / ')} is set in the environment; refusing to run Claude on API-key billing`);
    }
    // `effort` is per session and only valid for models that list effort levels (haiku lists none)
    const models = this.models ?? (await this.probe()).models;
    const efforts = models.find((m) => m.id === o.model)?.efforts ?? [];
    const effort = o.effort !== undefined && efforts.includes(o.effort) ? (o.effort as EffortLevel) : undefined;

    const session: ClaudeSession = new ClaudeSession(
      {
        pathToClaudeCodeExecutable: resolveClaude(),
        env: childEnv(),
        cwd: o.cwd,
        model: o.model,
        effort,
        includePartialMessages: true,
        persistSession: false,
        // read-only by policy: there is no OS sandbox as with Codex
        disallowedTools: ['Write', 'Edit', 'NotebookEdit'],
        permissionMode: 'default',
        stderr: (data) => {
          if (process.env.WAYPOINT_TRACE) console.error(`claude stderr: ${data.trimEnd()}`);
        },
      },
      onEvent,
      () => this.sessions.delete(session),
    );
    this.sessions.add(session);

    // gate before the first turn: subscription billing only
    let auth: RuntimeStatus['auth'];
    try {
      auth = authState(await session.accountInfo());
    } catch (e) {
      await session.close();
      throw e;
    }
    if (auth.state !== 'subscription') {
      await session.close();
      throw new Error(`Claude is not on subscription billing (auth: ${auth.state}); refusing to open a session`);
    }

    session.emit({ type: 'session.ready', model: o.model, effort });
    return session;
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([...this.sessions].map((s) => s.close()));
  }
}
