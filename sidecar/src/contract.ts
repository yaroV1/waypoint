// Contract from ITERATION_0.1_DESIGN.md section F. Shared by the sidecar and the UI.

export type ProviderId = 'codex' | 'claude';

export interface AgentRuntime {
  readonly provider: ProviderId;
  probe(): Promise<RuntimeStatus>;               // auth + models, zero model usage
  openSession(o: SessionOptions, onEvent: (e: AgentEvent) => void): Promise<AgentSession>;
  dispose(): Promise<void>;                      // kill every owned process
}

export interface AgentSession {
  readonly id: string;                           // Waypoint-owned
  readonly providerRef: { provider: ProviderId; nativeId: string };
  startTurn(input: string): Promise<{ turnId: string }>;   // rejects while a turn is active
  respond(requestId: string, r: InteractionResponse): Promise<void>;
  interrupt(): Promise<void>;                    // outcome arrives as turn.ended
  close(): Promise<void>;
}

export interface RuntimeStatus {
  available: boolean;
  version?: string;
  auth: { state: 'subscription' | 'api-key' | 'unauthenticated' | 'unknown'; plan?: string };
  models: { id: string; displayName: string; isDefault: boolean; efforts: string[]; defaultEffort?: string }[];
  traits: {                                      // only where providers actually differ
    userQuestions: 'native' | 'plan-mode-experimental';
    readOnlyEnforcement: 'os-sandbox' | 'permission-policy';
    effortScope: 'turn' | 'session';
  };
}

export interface SessionOptions { cwd: string; model: string; effort?: string }  // read-only hardcoded in 0.1

export type AgentEvent = { sessionId: string; seq: number; ts: number; raw?: unknown } & (
  | { type: 'session.ready'; model: string; effort?: string }
  | { type: 'turn.started'; turnId: string }
  | { type: 'message.delta' | 'message.completed'; turnId: string; itemId: string; text: string }
  | { type: 'activity'; turnId: string; itemId: string; phase: 'started' | 'completed';
      kind: 'command' | 'fileChange' | 'mcpTool' | 'reasoning' | 'other';
      title: string; status?: 'ok' | 'failed' | 'declined' }
  | { type: 'request.opened'; turnId: string; requestId: string; request: ApprovalRequest | QuestionRequest }
  | { type: 'request.resolved'; requestId: string; by: 'user' | 'provider' | 'interrupt' }
  | { type: 'turn.ended'; turnId: string; outcome: 'completed' | 'interrupted' | 'failed';
      error?: { message: string; retryable?: boolean } }
  | { type: 'notice'; level: 'info' | 'warning' | 'error'; message: string }
  | { type: 'session.closed'; reason: 'requested' | 'process-exit'; exitCode?: number });

export interface ApprovalRequest {
  kind: 'approval';
  title: string;
  detail?: string;
  // 'allow-always' outlives the session (design Deviations 2)
  options: { id: string; label: string; effect: 'allow' | 'allow-session' | 'allow-always' | 'deny' | 'cancel-turn' }[];
}

export interface QuestionRequest {
  kind: 'question';
  questions: {
    id: string; header?: string; text: string;
    options?: { label: string; description?: string }[];
    multiSelect: boolean; allowFreeText: boolean; secret: boolean;
  }[];
}

export type InteractionResponse = { optionId: string } | { answers: Record<string, string[]> };

// Wire protocol: {id, cmd, …} → {id, ok, result | error}, plus {event}.
// Only the commands implemented so far.

export type Command =
  | { id: number; cmd: 'probe'; provider: ProviderId }
  | { id: number; cmd: 'session.open'; provider: ProviderId; options: SessionOptions }
  | { id: number; cmd: 'turn.start'; sessionId: string; input: string }
  | { id: number; cmd: 'request.respond'; sessionId: string; requestId: string; response: InteractionResponse }
  | { id: number; cmd: 'turn.interrupt'; sessionId: string }
  | { id: number; cmd: 'session.close'; sessionId: string }
  | { id: number; cmd: 'shutdown' };

export type Reply =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

export type EventMessage = { event: AgentEvent };
