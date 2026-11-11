import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  base: "/api/viewer/runtime/",
  build: {
    outDir: resolve(__dirname, "../../calcgo/web/viewer_runtime"),
    emptyOutDir: true,
    lib: {
      entry: resolve(__dirname, "src/main.js"),
      name: "CalcgoDatasetViewer",
      formats: ["iife"],
      fileName: () => "viewer.js"
    },
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        assetFileNames: (asset) =>
          asset.name && asset.name.endsWith(".css") ? "viewer.css" : "assets/[name]-[hash][extname]"
      }
    }
  }
});
