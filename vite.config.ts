import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:8787", changeOrigin: true },
      "/pay": { target: "http://localhost:8787", changeOrigin: true },
    },
  },
});
