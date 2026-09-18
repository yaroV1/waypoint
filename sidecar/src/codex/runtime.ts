import { randomUUID } from 'node:crypto';
import type {
  AgentEvent,
  AgentRuntime,
  AgentSession,
  ApprovalRequest,
  InteractionResponse,
  RuntimeStatus,
  SessionOptions,
} from '../contract.ts';
import { CodexRpc } from './rpc.ts';
import type { InitializeParams } from './generated/InitializeParams.ts';
import type { InitializeResponse } from './generated/InitializeResponse.ts';
import type { RequestId } from './generated/RequestId.ts';
import type { AgentMessageDeltaNotification } from './generated/v2/AgentMessageDeltaNotification.ts';
import type { CommandExecutionApprovalDecision } from './generated/v2/CommandExecutionApprovalDecision.ts';
import type { CommandExecutionRequestApprovalParams } from './generated/v2/CommandExecutionRequestApprovalParams.ts';
import type { ErrorNotification } from './generated/v2/ErrorNotification.ts';
import type { FileChangeApprovalDecision } from './generated/v2/FileChangeApprovalDecision.ts';
import type { FileChangeRequestApprovalParams } from './generated/v2/FileChangeRequestApprovalParams.ts';
import type { GetAccountResponse } from './generated/v2/GetAccountResponse.ts';
import type { ItemCompletedNotification } from './generated/v2/ItemCompletedNotification.ts';
import type { ItemStartedNotification } from './generated/v2/ItemStartedNotification.ts';
import type { ModelListParams } from './generated/v2/ModelListParams.ts';
import type { ModelListResponse } from './generated/v2/ModelListResponse.ts';
import type { ServerRequestResolvedNotification } from './generated/v2/ServerRequestResolvedNotification.ts';
import type { ThreadItem } from './generated/v2/ThreadItem.ts';
import type { ThreadStartParams } from './generated/v2/ThreadStartParams.ts';
import type { ThreadStartResponse } from './generated/v2/ThreadStartResponse.ts';
import type { ThreadUnsubscribeParams } from './generated/v2/ThreadUnsubscribeParams.ts';
import type { TurnCompletedNotification } from './generated/v2/TurnCompletedNotification.ts';
import type { TurnInterruptParams } from './generated/v2/TurnInterruptParams.ts';
import type { TurnStartParams } from './generated/v2/TurnStartParams.ts';
import type { TurnStartResponse } from './generated/v2/TurnStartResponse.ts';
import type { TurnStartedNotification } from './generated/v2/TurnStartedNotification.ts';
import type { WarningNotification } from './generated/v2/WarningNotification.ts';

// distributive Omit, so the AgentEvent union survives
type EventBody = AgentEvent extends infer E ? (E extends AgentEvent ? Omit<E, 'sessionId' | 'seq' | 'ts'> : never) : never;
type ActivityFields = Pick<Extract<AgentEvent, { type: 'activity' }>, 'kind' | 'title' | 'status'>;

function describeItem(item: ThreadItem): ActivityFields {
  switch (item.type) {
    case 'commandExecution':
      return {
        kind: 'command',
        title: item.command,
        status: item.status === 'completed' ? 'ok' : item.status === 'inProgress' ? undefined : item.status,
      };
    case 'fileChange':
      return {
        kind: 'fileChange',
        title: item.changes.map((c) => c.path).join(', '),
        status: item.status === 'completed' ? 'ok' : item.status === 'inProgress' ? undefined : item.status,
      };
    case 'mcpToolCall':
      return {
        kind: 'mcpTool',
        title: `${item.server}.${item.tool}`,
        status: item.status === 'completed' ? 'ok' : item.status === 'inProgress' ? undefined : item.status,
      };
    case 'reasoning':
      return { kind: 'reasoning', title: item.summary.join(' ') || 'reasoning' };
    default:
      return { kind: 'other', title: item.type };
  }
}

type ApprovalDecision = CommandExecutionApprovalDecision | FileChangeApprovalDecision;
type ApprovalOption = ApprovalRequest['options'][number];

const DEFAULT_DECISIONS: FileChangeApprovalDecision[] = ['accept', 'acceptForSession', 'decline', 'cancel'];

// Options are generated from the decisions Codex offers for this request (design F).
function describeDecision(d: ApprovalDecision, index: number): ApprovalOption {
  if (d === 'accept') return { id: d, label: 'Approve', effect: 'allow' };
  if (d === 'acceptForSession') return { id: d, label: 'Approve for this session', effect: 'allow-session' };
  if (d === 'decline') return { id: d, label: 'Decline', effect: 'deny' };
  if (d === 'cancel') return { id: d, label: 'Cancel turn', effect: 'cancel-turn' };
  if ('acceptWithExecpolicyAmendment' in d) {
    const rule = d.acceptWithExecpolicyAmendment.execpolicy_amendment.join(' ');
    // outlives the session: Codex records the amendment in its exec policy
    return { id: `acceptWithExecpolicyAmendment:${index}`, label: `Approve and always allow (Codex exec policy): ${rule}`, effect: 'allow-always' };
  }
  const { host, action } = d.applyNetworkPolicyAmendment.network_policy_amendment;
  return {
    id: `applyNetworkPolicyAmendment:${index}`,
    label: `${action === 'allow' ? 'Always allow' : 'Always deny'} network host ${host}`,
    effect: action === 'allow' ? 'allow-always' : 'deny',
  };
}

type OpenRequest = { rpcId: RequestId; decisions: Map<string, ApprovalDecision> };

class CodexSession implements AgentSession {
  readonly id = randomUUID();
  readonly providerRef: { provider: 'codex'; nativeId: string };
  private readonly rpc: CodexRpc;
  private readonly effort: string | undefined;
  private readonly onEvent: (e: AgentEvent) => void;
  private readonly onClosed: () => void;
  private readonly requests = new Map<string, OpenRequest>(); // by Waypoint requestId
  private readonly fileChanges = new Map<string, string>(); // item id -> changed paths
  private seq = 0;
  private turnActive = false;
  private turnId: string | null = null;

  constructor(rpc: CodexRpc, threadId: string, effort: string | undefined, onEvent: (e: AgentEvent) => void, onClosed: () => void) {
    this.rpc = rpc;
    this.providerRef = { provider: 'codex', nativeId: threadId };
    this.effort = effort;
    this.onEvent = onEvent;
    this.onClosed = onClosed;
  }

  emit(body: EventBody): void {
    this.onEvent({ sessionId: this.id, seq: this.seq++, ts: Date.now(), ...body } as AgentEvent);
  }

  async startTurn(input: string): Promise<{ turnId: string }> {
    if (this.turnActive) throw new Error('a turn is already active');
    this.turnActive = true;
    try {
      const params: TurnStartParams = {
        threadId: this.providerRef.nativeId,
        input: [{ type: 'text', text: input, text_elements: [] }],
        effort: this.effort,
      };
      const res = await this.rpc.request<TurnStartResponse>('turn/start', params);
      this.turnId = res.turn.id;
      return { turnId: res.turn.id };
    } catch (e) {
      this.turnActive = false;
      throw e;
    }
  }

  async respond(requestId: string, r: InteractionResponse): Promise<void> {
    const req = this.requests.get(requestId);
    if (!req) throw new Error(`unknown request: ${requestId}`);
    if (!('optionId' in r)) throw new Error('an approval expects { optionId }');
    const decision = req.decisions.get(r.optionId);
    if (decision === undefined) throw new Error(`unknown option: ${r.optionId}`);
    this.requests.delete(requestId);
    this.rpc.respond(req.rpcId, { decision });
    this.emit({ type: 'request.resolved', requestId, by: 'user' });
  }

  async interrupt(): Promise<void> {
    if (!this.turnActive || !this.turnId) return;
    for (const [requestId, req] of this.requests) {
      this.requests.delete(requestId);
      this.rpc.respond(req.rpcId, { decision: 'cancel' });
      this.emit({ type: 'request.resolved', requestId, by: 'interrupt' });
    }
    const params: TurnInterruptParams = { threadId: this.providerRef.nativeId, turnId: this.turnId };
    await this.rpc.request('turn/interrupt', params);
  }

  async close(): Promise<void> {
    const params: ThreadUnsubscribeParams = { threadId: this.providerRef.nativeId };
    await this.rpc.request('thread/unsubscribe', params);
    this.onClosed();
    this.emit({ type: 'session.closed', reason: 'requested' });
  }

  handleNotification(method: string, params: unknown, raw: unknown): void {
    switch (method) {
      case 'turn/started': {
        const p = params as TurnStartedNotification;
        this.turnActive = true;
        this.turnId = p.turn.id;
        this.emit({ type: 'turn.started', turnId: p.turn.id, raw });
        break;
      }
      case 'item/agentMessage/delta': {
        const p = params as AgentMessageDeltaNotification;
        this.emit({ type: 'message.delta', turnId: p.turnId, itemId: p.itemId, text: p.delta, raw });
        break;
      }
      case 'item/started': {
        const p = params as ItemStartedNotification;
        if (p.item.type === 'agentMessage' || p.item.type === 'userMessage') break;
        if (p.item.type === 'fileChange') this.fileChanges.set(p.item.id, describeItem(p.item).title);
        this.emit({ type: 'activity', turnId: p.turnId, itemId: p.item.id, phase: 'started', ...describeItem(p.item), raw });
        break;
      }
      case 'item/completed': {
        const p = params as ItemCompletedNotification;
        if (p.item.type === 'userMessage') break;
        if (p.item.type === 'agentMessage') {
          this.emit({ type: 'message.completed', turnId: p.turnId, itemId: p.item.id, text: p.item.text, raw });
          break;
        }
        this.emit({ type: 'activity', turnId: p.turnId, itemId: p.item.id, phase: 'completed', ...describeItem(p.item), raw });
        break;
      }
      case 'turn/completed': {
        const p = params as TurnCompletedNotification;
        if (p.turn.status === 'inProgress') break;
        this.turnActive = false;
        this.turnId = null;
        this.fileChanges.clear();
        this.emit({
          type: 'turn.ended',
          turnId: p.turn.id,
          outcome: p.turn.status,
          error: p.turn.error ? { message: p.turn.error.message } : undefined,
          raw,
        });
        break;
      }
      case 'serverRequest/resolved': {
        // also sent after our own answer; only requests that are still open were resolved by Codex
        const p = params as ServerRequestResolvedNotification;
        for (const [requestId, req] of this.requests) {
          if (req.rpcId !== p.requestId) continue;
          this.requests.delete(requestId);
          this.emit({ type: 'request.resolved', requestId, by: 'provider', raw });
        }
        break;
      }
      case 'error': {
        const p = params as ErrorNotification;
        this.emit({ type: 'notice', level: p.willRetry ? 'warning' : 'error', message: p.error.message, raw });
        break;
      }
      case 'warning': {
        const p = params as WarningNotification;
        this.emit({ type: 'notice', level: 'warning', message: p.message, raw });
        break;
      }
    }
  }

  private openApproval(rpcId: RequestId, turnId: string, available: ApprovalDecision[], title: string, detail: string, raw: unknown): void {
    const requestId = randomUUID();
    const decisions = new Map<string, ApprovalDecision>();
    const options = available.map((d, i) => {
      const option = describeDecision(d, i);
      decisions.set(option.id, d);
      return option;
    });
    this.requests.set(requestId, { rpcId, decisions });
    this.emit({ type: 'request.opened', turnId, requestId, request: { kind: 'approval', title, detail: detail || undefined, options }, raw });
  }

  // The JSON-RPC id is held until respond(); the turn blocks meanwhile (design G).
  handleServerRequest(id: RequestId, method: string, params: unknown, raw: unknown): void {
    if (method === 'item/commandExecution/requestApproval') {
      const p = params as CommandExecutionRequestApprovalParams;
      const detail = [p.reason, p.cwd ? `cwd: ${p.cwd}` : null].filter(Boolean).join('\n');
      this.openApproval(id, p.turnId, p.availableDecisions ?? DEFAULT_DECISIONS, p.command ?? p.kind, detail, raw);
      return;
    }
    if (method === 'item/fileChange/requestApproval') {
      const p = params as FileChangeRequestApprovalParams;
      const detail = [p.reason, p.grantRoot ? `grant root: ${p.grantRoot}` : null].filter(Boolean).join('\n');
      this.openApproval(id, p.turnId, DEFAULT_DECISIONS, `Change files: ${this.fileChanges.get(p.itemId) ?? p.itemId}`, detail, raw);
      return;
    }
    // Questions come in slice 5; anything else is refused and the turn interrupted so it cannot hang.
    this.rpc.respondError(id, `${method} is not supported by this client yet`);
    this.emit({ type: 'notice', level: 'warning', message: `${method} refused (not implemented yet); interrupting the turn`, raw });
    this.interrupt().catch(() => {});
  }

  handleProcessExit(code: number | null): void {
    if (this.turnActive && this.turnId) {
      this.emit({ type: 'turn.ended', turnId: this.turnId, outcome: 'failed', error: { message: 'codex app-server exited' } });
    }
    this.turnActive = false;
    this.requests.clear();
    this.emit({ type: 'session.closed', reason: 'process-exit', exitCode: code ?? undefined });
  }
}

export class CodexRuntime implements AgentRuntime {
  readonly provider = 'codex';
  private rpc: CodexRpc | null = null;
  private initialized: Promise<InitializeResponse> | null = null;
  private readonly sessions = new Map<string, CodexSession>(); // by threadId

  // one app-server process, started lazily
  private connect(): { rpc: CodexRpc; initialized: Promise<InitializeResponse> } {
    if (this.rpc && this.initialized) return { rpc: this.rpc, initialized: this.initialized };
    const rpc = new CodexRpc({
      onNotification: (method, params, raw) => {
        const threadId = (params as { threadId?: string | null } | undefined)?.threadId;
        if (threadId) this.sessions.get(threadId)?.handleNotification(method, params, raw);
      },
      onServerRequest: (id, method, params, raw) => {
        if (method === 'currentTime/read') {
          rpc.respond(id, { currentTimeAt: Math.floor(Date.now() / 1000) });
          return;
        }
        const threadId = (params as { threadId?: string } | undefined)?.threadId;
        const session = threadId ? this.sessions.get(threadId) : undefined;
        if (session) session.handleServerRequest(id, method, params, raw);
        else rpc.respondError(id, `${method} is not supported by this client`);
      },
      onExit: (code) => {
        if (this.rpc !== rpc) return;
        this.rpc = null;
        this.initialized = null;
        for (const s of this.sessions.values()) s.handleProcessExit(code);
        this.sessions.clear();
      },
    });
    const params: InitializeParams = {
      clientInfo: { name: 'waypoint', title: 'Waypoint', version: '0.1.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    };
    const initialized = rpc.request<InitializeResponse>('initialize', params).then((res) => {
      rpc.notify('initialized');
      return res;
    });
    this.rpc = rpc;
    this.initialized = initialized;
    return { rpc, initialized };
  }

  async probe(): Promise<RuntimeStatus> {
    const traits: RuntimeStatus['traits'] = {
      userQuestions: 'plan-mode-experimental',
      readOnlyEnforcement: 'os-sandbox',
      effortScope: 'turn',
    };
    let rpc: CodexRpc;
    let init: InitializeResponse;
    try {
      const c = this.connect();
      rpc = c.rpc;
      init = await c.initialized;
    } catch {
      return { available: false, auth: { state: 'unknown' }, models: [], traits };
    }

    const { account } = await rpc.request<GetAccountResponse>('account/read', {});
    const auth: RuntimeStatus['auth'] =
      account === null
        ? { state: 'unauthenticated' }
        : account.type === 'chatgpt'
          ? { state: 'subscription', plan: account.planType }
          : account.type === 'apiKey'
            ? { state: 'api-key' }
            : { state: 'unknown' };

    const models: RuntimeStatus['models'] = [];
    let cursor: string | null = null;
    do {
      const params: ModelListParams = { cursor };
      const page: ModelListResponse = await rpc.request<ModelListResponse>('model/list', params);
      for (const m of page.data) {
        if (m.hidden) continue;
        models.push({
          id: m.id,
          displayName: m.displayName,
          isDefault: m.isDefault,
          efforts: m.supportedReasoningEfforts.map((e) => e.reasoningEffort),
          defaultEffort: m.defaultReasoningEffort,
        });
      }
      cursor = page.nextCursor;
    } while (cursor);

    // userAgent looks like "waypoint/0.152.0 (Mac OS 15.6.0; arm64) …"
    const version = /^\S+\/(\S+)/.exec(init.userAgent)?.[1];
    return { available: true, version, auth, models, traits };
  }

  async openSession(o: SessionOptions, onEvent: (e: AgentEvent) => void): Promise<AgentSession> {
    const { rpc, initialized } = this.connect();
    await initialized;
    const params: ThreadStartParams = {
      model: o.model,
      cwd: o.cwd,
      sandbox: 'read-only',
      approvalPolicy: 'on-request',
      ephemeral: true,
    };
    const res = await rpc.request<ThreadStartResponse>('thread/start', params);
    const threadId = res.thread.id;
    const session = new CodexSession(rpc, threadId, o.effort, onEvent, () => this.sessions.delete(threadId));
    this.sessions.set(threadId, session);
    session.emit({ type: 'session.ready', model: res.model, effort: o.effort, raw: res });
    return session;
  }

  async dispose(): Promise<void> {
    await this.rpc?.close();
  }
}
