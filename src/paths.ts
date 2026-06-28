// POSIX path helpers (macOS/Linux only — see CLAUDE.md). Shared by the workspace
// controller and the Pane component.

export function basename(p: string): string {
  return p.replace(/\/+$/, "").split("/").pop() || p;
}

export function dirname(p: string): string {
  const parts = p.replace(/\/+$/, "").split("/");
  parts.pop();
  return parts.join("/");
}

export function relativeToVault(p: string, vaultPath: string | null): string {
  if (vaultPath && p.startsWith(vaultPath)) {
    return p.slice(vaultPath.length).replace(/^\/+/, "");
  }
  return p;
}
