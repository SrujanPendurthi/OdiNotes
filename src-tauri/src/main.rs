// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// A node in the vault tree: either a folder (with children) or a `.md` file.
#[derive(Serialize)]
struct FileNode {
    name: String,
    path: String,
    is_dir: bool,
    children: Vec<FileNode>,
}

/// Recursively collect folders and `.md` files, hiding dotfiles. Folders are
/// listed before files; both are sorted case-insensitively.
fn build_tree(dir: &Path) -> Vec<FileNode> {
    let read = match fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };

    let mut nodes: Vec<FileNode> = Vec::new();
    for entry in read.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }

        if path.is_dir() {
            nodes.push(FileNode {
                name,
                path: path.to_string_lossy().to_string(),
                is_dir: true,
                children: build_tree(&path),
            });
        } else if path.extension().and_then(|e| e.to_str()) == Some("md") {
            nodes.push(FileNode {
                name,
                path: path.to_string_lossy().to_string(),
                is_dir: false,
                children: Vec::new(),
            });
        }
    }

    nodes.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    nodes
}

#[tauri::command]
fn list_tree(path: String) -> Vec<FileNode> {
    build_tree(Path::new(&path))
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_file(path: String, contents: String) -> Result<(), String> {
    fs::write(&path, contents).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_file(dir: String, name: String) -> Result<String, String> {
    let mut file_name = name.trim().to_string();
    if file_name.is_empty() {
        return Err("Name cannot be empty".into());
    }
    if !file_name.ends_with(".md") {
        file_name.push_str(".md");
    }

    let path = PathBuf::from(&dir).join(&file_name);
    if path.exists() {
        return Err("A note with that name already exists".into());
    }
    fs::write(&path, "").map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/// Move a file or folder into `dest_dir`, keeping its name. Returns the new path.
#[tauri::command]
fn move_path(src: String, dest_dir: String) -> Result<String, String> {
    let src_path = PathBuf::from(&src);
    let dest_dir_path = PathBuf::from(&dest_dir);

    let name = src_path
        .file_name()
        .ok_or_else(|| "Invalid source path".to_string())?;
    let target = dest_dir_path.join(name);

    // Dropping onto its current parent is a no-op.
    if target == src_path {
        return Ok(src);
    }
    // A folder cannot be moved into itself or any of its descendants.
    if src_path.is_dir() && dest_dir_path.starts_with(&src_path) {
        return Err("Cannot move a folder into itself".into());
    }
    if target.exists() {
        return Err("An item with that name already exists in the destination".into());
    }

    fs::rename(&src_path, &target).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
fn create_dir(parent: String, name: String) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Name cannot be empty".into());
    }

    let path = PathBuf::from(&parent).join(name);
    if path.exists() {
        return Err("A folder with that name already exists".into());
    }
    fs::create_dir(&path).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/// Put the macOS title bar in "overlay" mode: the content view fills the whole
/// window (extending under the title bar) and the title text is hidden, while
/// the native traffic-light buttons stay. This lets our HTML top bar sit on the
/// same row as those buttons. Done at runtime so it doesn't depend on Tauri's
/// platform-specific config-file merge.
#[cfg(target_os = "macos")]
fn apply_overlay_titlebar(window: &tauri::WebviewWindow) {
    use objc::runtime::Object;
    use objc::{msg_send, sel, sel_impl};

    // NSWindowStyleMask::FullSizeContentView and NSWindowTitleVisibility::Hidden.
    const NS_FULL_SIZE_CONTENT_VIEW: usize = 1 << 15;
    const NS_WINDOW_TITLE_HIDDEN: isize = 1;

    let ns_window = match window.ns_window() {
        Ok(ptr) => ptr as *mut Object,
        Err(_) => return,
    };

    unsafe {
        let style: usize = msg_send![ns_window, styleMask];
        let _: () = msg_send![ns_window, setStyleMask: style | NS_FULL_SIZE_CONTENT_VIEW];
        let _: () = msg_send![ns_window, setTitlebarAppearsTransparent: true];
        let _: () = msg_send![ns_window, setTitleVisibility: NS_WINDOW_TITLE_HIDDEN];
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|_app| {
            #[cfg(target_os = "macos")]
            {
                use tauri::Manager;
                if let Some(window) = _app.get_webview_window("main") {
                    apply_overlay_titlebar(&window);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_tree,
            read_file,
            write_file,
            create_file,
            create_dir,
            move_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running OdiNotes");
}
