use std::process::Command;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![validate_repo])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
