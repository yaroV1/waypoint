import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { AgentEvent, ProviderId, RuntimeStatus } from "../sidecar/src/contract.ts";
import { call, onAgentEvent, onSidecarExit } from "./sidecar.ts";

type RepoInfo = { root: string; branch: string };
type Status = "idle" | "running" | "waiting-for-user" | "completed" | "failed" | "interrupted";
type Entry = { key: string; itemId?: string; text: string };

function describe(e: AgentEvent): string {
  switch (e.type) {
    case "session.ready":
      return `session ready · ${e.model}${e.effort ? ` · ${e.effort}` : ""}`;
    case "turn.started":
      return "turn started";
    case "activity":
      return `${e.kind} ${e.phase}: ${e.title}${e.status ? ` (${e.status})` : ""}`;
    case "turn.ended":
      return `turn ${e.outcome}${e.error ? `: ${e.error.message}` : ""}`;
    case "notice":
      return `${e.level}: ${e.message}`;
    case "session.closed":
      return `session closed (${e.reason}${e.exitCode !== undefined ? `, code ${e.exitCode}` : ""})`;
    default:
      return e.type;
  }
}

function App() {
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [error, setError] = useState("");
  const [provider, setProvider] = useState<ProviderId>("codex");
  const [probe, setProbe] = useState<RuntimeStatus | null>(null);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [prompt, setPrompt] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [rawEvents, setRawEvents] = useState<AgentEvent[]>([]);
  // open session and the options it was opened with
  const session = useRef<{ id: string; key: string } | null>(null);

  function addLine(text: string) {
    setEntries((l) => [...l, { key: `${l.length}`, text }]);
  }

  useEffect(() => {
    const offEvent = onAgentEvent((e) => {
      setRawEvents((l) => [...l, e]);
      if (e.type === "message.delta" || e.type === "message.completed") {
        setEntries((l) => {
          const i = l.findIndex((x) => x.itemId === e.itemId);
          if (i === -1) return [...l, { key: `${l.length}`, itemId: e.itemId, text: e.text }];
          const text = e.type === "message.delta" ? l[i].text + e.text : e.text;
          return l.map((x, j) => (j === i ? { ...x, text } : x));
        });
        return;
      }
      setEntries((l) => [...l, { key: `${l.length}`, text: `· ${describe(e)}` }]);
      if (e.type === "turn.started") setStatus("running");
      if (e.type === "turn.ended") setStatus(e.outcome);
      if (e.type === "session.closed") session.current = null;
    });
    const offExit = onSidecarExit((code) => {
      session.current = null;
      setStatus("failed");
      setError(`sidecar exited (code ${code}); restart the app`);
    });
    return () => {
      offEvent();
      offExit();
    };
  }, []);

  useEffect(() => {
    let stale = false;
    setProbe(null);
    call<RuntimeStatus>({ cmd: "probe", provider }).then(
      (s) => {
        if (stale) return;
        setProbe(s);
        const m = s.models.find((x) => x.isDefault) ?? s.models[0];
        setModel(m?.id ?? "");
        setEffort(m?.defaultEffort ?? m?.efforts[0] ?? "");
      },
      (e) => !stale && setError(`probe failed: ${e.message}`),
    );
    return () => {
      stale = true;
    };
  }, [provider]);

  async function pickFolder() {
    const path = await open({ directory: true });
    if (!path) return;
    setRepo(null);
    setError("");
    try {
      setRepo(await invoke<RepoInfo>("validate_repo", { path }));
    } catch (e) {
      setError(`${path}: ${e}`);
    }
  }

  async function run() {
    if (!repo) return;
    setError("");
    setStatus("running");
    try {
      const key = JSON.stringify([provider, repo.root, model, effort]);
      if (session.current && session.current.key !== key) {
        await call({ cmd: "session.close", sessionId: session.current.id });
        session.current = null;
      }
      if (!session.current) {
        const options = { cwd: repo.root, model, effort: effort || undefined };
        const { sessionId } = await call<{ sessionId: string }>({ cmd: "session.open", provider, options });
        session.current = { id: sessionId, key };
      }
      addLine(`> ${prompt}`);
      await call({ cmd: "turn.start", sessionId: session.current.id, input: prompt });
    } catch (e) {
      setStatus("failed");
      setError(String(e));
    }
  }

  const selectedModel = probe?.models.find((m) => m.id === model);
  const busy = status === "running" || status === "waiting-for-user";

  return (
    <main>
      <h1>Waypoint</h1>
      <p>
        <button onClick={pickFolder} disabled={busy}>Pick folder</button>{" "}
        {repo && `${repo.root} · ${repo.branch || "(detached HEAD)"}`}
      </p>
      <p>
        {(["codex", "claude"] as const).map((p) => (
          <label key={p}>
            <input
              type="radio"
              checked={provider === p}
              disabled={busy}
              onChange={() => setProvider(p)}
            />
            {p}{" "}
          </label>
        ))}
        {probe ? (
          <span style={{ color: probe.auth.state === "api-key" ? "red" : undefined }}>
            [{probe.available ? "" : "unavailable · "}
            {probe.auth.state}
            {probe.auth.plan ? ` · ${probe.auth.plan}` : ""}
            {probe.version ? ` · v${probe.version}` : ""}]
          </span>
        ) : (
          "[probing…]"
        )}
      </p>
      <p>
        <select
          value={model}
          disabled={busy}
          onChange={(e) => {
            setModel(e.target.value);
            const m = probe?.models.find((x) => x.id === e.target.value);
            setEffort(m?.defaultEffort ?? m?.efforts[0] ?? "");
          }}
        >
          {probe?.models.map((m) => (
            <option key={m.id} value={m.id}>{m.displayName}</option>
          ))}
        </select>{" "}
        <select value={effort} disabled={busy} onChange={(e) => setEffort(e.target.value)}>
          {selectedModel?.efforts.map((x) => (
            <option key={x} value={x}>{x}</option>
          ))}
        </select>
      </p>
      <textarea
        rows={4}
        style={{ width: "100%", boxSizing: "border-box" }}
        placeholder="Read-only prompt"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
      />
      <p>
        <button onClick={run} disabled={busy || !repo || !model || !prompt.trim()}>Run</button> status: {status}
      </p>
      {error && <p style={{ color: "red" }}>{error}</p>}
      <div>
        {entries.map((x) => (
          <div key={x.key} style={{ whiteSpace: "pre-wrap", color: x.itemId ? undefined : "gray" }}>{x.text}</div>
        ))}
      </div>
      <details>
        <summary>raw events ({rawEvents.length})</summary>
        <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
          {rawEvents.map((e) => JSON.stringify(e)).join("\n")}
        </pre>
      </details>
    </main>
  );
}

export default App;
