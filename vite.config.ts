import { defineConfig } from "vite";

// In development, Vite serves the page and passes /api calls to the small server.
export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
  preview: { host: "127.0.0.1" },
  build: { outDir: "dist", sourcemap: false },
});
