import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false,
  plugins: [{
    name: "function-commonjs-package",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "package.json", source: JSON.stringify({ type: "commonjs" }) });
    },
  }],
  build: {
    target: "node22",
    outDir: "dist-function",
    emptyOutDir: true,
    ssr: "server/yandex/index.ts",
    rollupOptions: {
      output: { format: "cjs", entryFileNames: "index.js", exports: "named" },
    },
    minify: false,
    sourcemap: true,
  },
  ssr: { noExternal: true },
});
