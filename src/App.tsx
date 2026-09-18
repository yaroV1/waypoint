import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { Command, ProviderId } from "../sidecar/src/contract.ts";

type RepoInfo = { root: string; branch: string };

function App() {
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [error, setError] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const nextId = useRef(1);

  useEffect(() => {
    const unlisten = [
      listen<string>("sidecar-line", (e) => setLog((l) => [...l, `← ${e.payload}`])),
      listen<{ code: number | null }>("sidecar-exit", (e) =>
        setLog((l) => [...l, `✖ sidecar exited, code ${e.payload.code}`]),
      ),
    ];
    return () => {
      unlisten.forEach((p) => p.then((f) => f()));
    };
  }, []);

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

  async function probe(provider: ProviderId) {
    const cmd: Command = { id: nextId.current++, cmd: "probe", provider };
    const line = JSON.stringify(cmd);
    setLog((l) => [...l, `→ ${line}`]);
    try {
      await invoke("sidecar_send", { line });
    } catch (e) {
      setLog((l) => [...l, `✖ ${e}`]);
    }
  }

  return (
    <main>
      <h1>Waypoint</h1>
      <button onClick={pickFolder}>Pick folder</button>
      {repo && (
        <p>
          {repo.root} · {repo.branch || "(detached HEAD)"}
        </p>
      )}
      {error && <p style={{ color: "red" }}>{error}</p>}
      <p>
        <button onClick={() => probe("codex")}>Probe codex</button>{" "}
        <button onClick={() => probe("claude")}>Probe claude</button>
      </p>
      <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{log.join("\n")}</pre>
    </main>
  );
}

export default App;
