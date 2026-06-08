import { defineConfig } from "vite-plus";

export default defineConfig({
  build: {
    ssr: "src/worker.ts",
    outDir: "dist",
  },
  ssr: {
    target: "webworker",
  },
  test: {
    include: ["tests/**/*.test.ts"],
  },
  staged: {
    "*": "vp check --fix",
  },
  lint: {
    ignorePatterns: ["repos/**", "legacy/**", "dist/**", ".alchemy/**"],
    options: { typeAware: true, typeCheck: true },
  },
});
