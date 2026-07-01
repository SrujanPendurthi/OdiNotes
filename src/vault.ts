// Thin, typed wrappers around the Rust file-system commands and the
// dialog plugin. All paths are absolute strings handed to the backend.
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

export interface FileNode {
  name: string;
  path: string;
  is_dir: boolean;
  children: FileNode[];
}

/** Native folder picker. Returns the chosen absolute path or null. */
export async function pickVault(): Promise<string | null> {
  const selected = await open({
    directory: true,
    multiple: false,
    title: "Select Vault Folder",
  });
  return typeof selected === "string" ? selected : null;
}

/** Recursively list folders and `.md` files under `path`. */
export const listTree = (path: string): Promise<FileNode[]> =>
  invoke("list_tree", { path });

export interface NoteContent {
  path: string;
  content: string;
}

/** Read the contents of every `.md` note in the vault (for the graph view). */
export const readAllNotes = (vault: string): Promise<NoteContent[]> =>
  invoke("read_all_notes", { vault });

export const readFile = (path: string): Promise<string> =>
  invoke("read_file", { path });

export const writeFile = (path: string, contents: string): Promise<void> =>
  invoke("write_file", { path, contents });

/** Create an empty `.md` note inside `dir`. Returns the new file path. */
export const createFile = (dir: string, name: string): Promise<string> =>
  invoke("create_file", { dir, name });

/** Create a new auto-numbered `Untitled.md` in `dir`. Returns the new file path. */
export const createUntitled = (dir: string): Promise<string> =>
  invoke("create_untitled", { dir });

/** Create a folder inside `parent`. Returns the new folder path. */
export const createDir = (parent: string, name: string): Promise<string> =>
  invoke("create_dir", { parent, name });

/** Rename a file or folder in place. Returns its new path. */
export const renamePath = (src: string, newName: string): Promise<string> =>
  invoke("rename_path", { src, newName });

/** Move a file or folder into `destDir`. Returns its new path. */
export const movePath = (src: string, destDir: string): Promise<string> =>
  invoke("move_path", { src, destDir });

/** Move a file or folder into the vault's hidden Trash folder. Returns its new path. */
export const trashPath = (vault: string, src: string): Promise<string> =>
  invoke("trash_path", { vault, src });
