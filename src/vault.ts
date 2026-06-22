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

export const readFile = (path: string): Promise<string> =>
  invoke("read_file", { path });

export const writeFile = (path: string, contents: string): Promise<void> =>
  invoke("write_file", { path, contents });

/** Create an empty `.md` note inside `dir`. Returns the new file path. */
export const createFile = (dir: string, name: string): Promise<string> =>
  invoke("create_file", { dir, name });

/** Create a folder inside `parent`. Returns the new folder path. */
export const createDir = (parent: string, name: string): Promise<string> =>
  invoke("create_dir", { parent, name });
