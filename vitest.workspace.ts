import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineWorkspace } from "vitest/config";

const alias = { "@shared": path.resolve(__dirname, "src/shared") };

export default defineWorkspace([
  {
    resolve: { alias },
    test: {
      name: "node",
      environment: "node",
      include: ["src/main/**/*.test.ts", "src/shared/**/*.test.ts"],
    },
  },
  {
    plugins: [react()],
    resolve: { alias },
    test: {
      name: "renderer",
      environment: "jsdom",
      include: ["src/renderer/**/*.test.{ts,tsx}"],
      setupFiles: ["src/renderer/test/setup.ts"],
    },
  },
]);
