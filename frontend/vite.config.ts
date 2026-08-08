import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev mode proxies /api to the console server (npm run console, port 8899).
// Production is served BY the console server from dist/.
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", sourcemap: false },
  server: {
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:8899" },
  },
});
