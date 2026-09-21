import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

// Builds the extension UI into dist/, with the manifest and service worker
// copied from public/. Relative asset paths keep chrome-extension:// URLs
// working, and everything is bundled locally (no remote code, MV3 compliant).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "chrome114",
    rollupOptions: {
      input: {
        app: resolve(__dirname, "app.html"),
      },
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
  server: {
    port: 4174,
  },
});
