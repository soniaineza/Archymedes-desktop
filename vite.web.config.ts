import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** The web edition of the enterprise OS (deployed to Vercel as a static site). */
export default defineConfig({
  root: resolve(__dirname, "web"),
  base: "/",
  plugins: [react()],
  resolve: { alias: { "@shared": resolve(__dirname, "src/shared") } },
  build: { outDir: resolve(__dirname, "dist-web"), emptyOutDir: true },
});
