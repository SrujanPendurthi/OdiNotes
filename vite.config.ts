import { defineConfig } from "vite";

// Tauri expects a fixed dev-server port and that Vite stays out of src-tauri.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  // Prevent Vite from clearing Tauri's Rust compiler output.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: {
      // Don't watch the Rust side — it has its own watcher.
      ignored: ["**/src-tauri/**"],
    },
  },
  // Produce a leaner bundle.
  build: {
    target: "es2021",
    minify: "esbuild",
    sourcemap: false,
  },
});
