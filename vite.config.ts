import { defineConfig } from "vite";
import pkg from "./package.json";

// 小梦备忘录 · Vite 配置
// dev 端口固定 1420，Tauri 的 devUrl 指向它
export default defineConfig({
  // 版本号只维护 package.json 一处，构建时注入前端（设置页「关于」显示）
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
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
