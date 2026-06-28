// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// Name of the vault-root folder that trashed items are moved into. It is
/// hidden from the UI (filtered out in `list_tree`).
const TRASH_DIR: &str = "Trash";

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
    let mut nodes = build_tree(Path::new(&path));
    // Hide the vault-root Trash folder; only ever filtered at the root, so a
    // user folder named "Trash" deeper in the tree still shows.
    nodes.retain(|n| !(n.is_dir && n.name == TRASH_DIR));
    nodes
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

const UNTITLED_BASE: &str = "Untitled";

/// Create a new empty `Untitled.md` (then `Untitled1.md`, `Untitled2.md`, …) in
/// `dir`, filling the lowest free number. Case-insensitive (so `untitled.md`
/// counts as a collision even on case-sensitive filesystems) and TOCTOU-safe:
/// the file is created atomically, and a lost race just advances to the next
/// number. Returns the new file's absolute path.
#[tauri::command]
fn create_untitled(dir: String) -> Result<String, String> {
    let dir_path = PathBuf::from(&dir);

    // Numeric suffixes already in use by "Untitled<n>.md". Strip the ".md"
    // extension first, then the "untitled" prefix, so the number is parsed off
    // the bare stem. The plain "Untitled.md" occupies slot 0.
    let mut taken: HashSet<u32> = HashSet::new();
    if let Ok(entries) = fs::read_dir(&dir_path) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_lowercase();
            let Some(stem) = name.strip_suffix(".md") else {
                continue;
            };
            let Some(rest) = stem.strip_prefix("untitled") else {
                continue;
            };
            if rest.is_empty() {
                taken.insert(0);
            } else if let Ok(n) = rest.parse::<u32>() {
                // Ignore odd forms ("Untitled01", "Untitled+1") that parse but
                // aren't names we'd generate, so they don't block a slot.
                if rest == n.to_string() {
                    taken.insert(n);
                }
            }
        }
    }

    // Walk up to the lowest free index (gap-fill) and create atomically.
    let mut n: u32 = 0;
    loop {
        if !taken.contains(&n) {
            let file_name = if n == 0 {
                format!("{UNTITLED_BASE}.md")
            } else {
                format!("{UNTITLED_BASE}{n}.md")
            };
            let path = dir_path.join(&file_name);
            match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
            {
                Ok(_) => return Ok(path.to_string_lossy().to_string()),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    taken.insert(n);
                }
                Err(e) => return Err(e.to_string()),
            }
        }
        n = n.checked_add(1).ok_or("Too many untitled notes")?;
    }
}

/// Rename a file or folder in place (within its own parent). Path separators are
/// rejected so a rename can't move or escape the folder; the `.md` extension is
/// preserved for files. Returns the new absolute path.
#[tauri::command]
fn rename_path(src: String, new_name: String) -> Result<String, String> {
    let src_path = PathBuf::from(&src);
    let parent = src_path
        .parent()
        .ok_or_else(|| "Invalid source path".to_string())?;

    let mut name = new_name.trim().to_string();
    if name.is_empty() {
        return Err("Name cannot be empty".into());
    }
    if name.contains('/') {
        return Err("Name cannot contain '/'".into());
    }
    if !src_path.is_dir() && !name.ends_with(".md") {
        name.push_str(".md");
    }

    let target = parent.join(&name);
    if target == src_path {
        return Ok(src); // unchanged
    }
    if target.exists() {
        // Allow a case-only rename of the same file on case-insensitive volumes
        // (e.g. "untitled.md" -> "Untitled.md"); reject a real other file.
        let same = fs::canonicalize(&target).ok() == fs::canonicalize(&src_path).ok();
        if !same {
            return Err("An item with that name already exists".into());
        }
    }

    fs::rename(&src_path, &target).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().to_string())
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

/// Move a file or folder into the vault's hidden `Trash` folder, creating it if
/// needed. On a name collision in Trash, a Unix-timestamp suffix is appended so
/// an earlier trashed item with the same name is never clobbered. Returns the
/// item's new path inside Trash.
#[tauri::command]
fn trash_path(vault: String, src: String) -> Result<String, String> {
    let src_path = PathBuf::from(&src);
    let name = src_path
        .file_name()
        .ok_or_else(|| "Invalid source path".to_string())?
        .to_string_lossy()
        .to_string();

    let trash_dir = PathBuf::from(&vault).join(TRASH_DIR);
    fs::create_dir_all(&trash_dir).map_err(|e| e.to_string())?;

    let mut target = trash_dir.join(&name);
    if target.exists() {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        // Insert the timestamp before the extension: "note.md" -> "note 1730.md".
        let renamed = match name.rsplit_once('.') {
            Some((stem, ext)) => format!("{stem} {ts}.{ext}"),
            None => format!("{name} {ts}"),
        };
        target = trash_dir.join(renamed);
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
            create_untitled,
            create_dir,
            move_path,
            rename_path,
            trash_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running OdiNotes");
}
