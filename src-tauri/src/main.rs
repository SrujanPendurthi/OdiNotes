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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            list_tree,
            read_file,
            write_file,
            create_file,
            create_dir
        ])
        .run(tauri::generate_context!())
        .expect("error while running OdiNotes");
}
