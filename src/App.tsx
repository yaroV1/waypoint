import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

type RepoInfo = { root: string; branch: string };

function App() {
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [error, setError] = useState("");

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
    </main>
  );
}

export default App;
