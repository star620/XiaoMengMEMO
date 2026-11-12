import { defineConfig } from "vite";

// 小梦备忘录 · Vite 配置
// dev 端口固定 1420，Tauri 的 devUrl 指向它
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "chrome105",
    minify: "esbuild",
    sourcemap: false,
    outDir: "dist",
    emptyOutDir: true,
  },
});
