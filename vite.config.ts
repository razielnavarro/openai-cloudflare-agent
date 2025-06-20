import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [cloudflare(), react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
            // Force the browser version of the `debug` package so it doesn't try to access
      // Node-specific properties like `process.stderr.fd` when running inside
      // Cloudflare Workers/Miniflare.
      debug: "debug/src/browser.js",
    },
  },
  build: {
    outDir: "public",
    emptyOutDir: true,
  },
});
