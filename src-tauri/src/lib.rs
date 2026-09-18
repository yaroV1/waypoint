use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tauri::{Emitter, Manager};

// Dev-only location; sidecar packaging is deferred (design section J).
const SIDECAR_ENTRY: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../sidecar/src/main.ts");
const SHUTDOWN_GRACE: Duration = Duration::from_secs(2);

#[derive(serde::Serialize)]
struct RepoInfo {
    root: String,
    branch: String,
}

fn git(path: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .map_err(|e| format!("failed to run git: {}", e))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[tauri::command]
fn validate_repo(path: &str) -> Result<RepoInfo, String> {
    if git(path, &["rev-parse", "--is-inside-work-tree"])? != "true" {
        return Err("not inside a Git work tree".to_string());
    }
    let root = git(path, &["rev-parse", "--show-toplevel"])?;
    // empty on detached HEAD
    let branch = git(path, &["branch", "--show-current"])?;
    Ok(RepoInfo { root, branch })
}

struct Sidecar {
    child: Arc<Mutex<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
}

#[derive(Clone, serde::Serialize)]
struct SidecarExit {
    code: Option<i32>,
}

fn spawn_sidecar(app: &tauri::AppHandle) -> std::io::Result<Sidecar> {
    let mut child = Command::new("node")
        .arg(SIDECAR_ENTRY)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()?;
    let stdin = child.stdin.take();
    let stdout = child.stdout.take().expect("sidecar stdout is piped");

    let child = Arc::new(Mutex::new(child));

    let handle = app.clone();
    let reader_child = child.clone();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            match line {
                Ok(line) => {
                    let _ = handle.emit("sidecar-line", line);
                }
                Err(_) => break,
            }
        }
        // stdout closed: the sidecar is gone or going
        // poll instead of wait() so the lock is never held while blocking
        let code = loop {
            match reader_child.lock().unwrap().try_wait() {
                Ok(None) => {}
                Ok(Some(status)) => break status.code(),
                Err(_) => break None,
            }
            thread::sleep(Duration::from_millis(50));
        };
        let _ = handle.emit("sidecar-exit", SidecarExit { code });
    });

    Ok(Sidecar {
        child,
        stdin: Mutex::new(stdin),
    })
}

#[tauri::command]
fn sidecar_send(state: tauri::State<Sidecar>, line: String) -> Result<(), String> {
    let mut guard = state.stdin.lock().unwrap();
    let stdin = guard.as_mut().ok_or("sidecar stdin is closed")?;
    stdin
        .write_all(line.as_bytes())
        .and_then(|_| stdin.write_all(b"\n"))
        .and_then(|_| stdin.flush())
        .map_err(|e| e.to_string())
}

fn shutdown_sidecar(app: &tauri::AppHandle) {
    let sidecar = app.state::<Sidecar>();
    // send `shutdown`, then close stdin (EOF is a shutdown for the sidecar too)
    if let Some(mut stdin) = sidecar.stdin.lock().unwrap().take() {
        let _ = stdin.write_all(b"{\"id\":0,\"cmd\":\"shutdown\"}\n");
        let _ = stdin.flush();
    }
    let deadline = Instant::now() + SHUTDOWN_GRACE;
    loop {
        let mut child = sidecar.child.lock().unwrap();
        match child.try_wait() {
            Ok(None) if Instant::now() < deadline => {}
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return;
            }
            _ => return,
        }
        drop(child);
        thread::sleep(Duration::from_millis(50));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let sidecar = spawn_sidecar(app.handle())?;
            app.manage(sidecar);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![validate_repo, sidecar_send])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                shutdown_sidecar(app);
            }
        });
}
