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
    include: [
      "tests/phase0/**/*.test.ts",
      "tests/phase1/**/*.test.ts",
      "tests/phase2/**/*.test.ts",
      "tests/phase3/**/*.test.ts",
      "tests/phase4/**/*.test.ts",
    ],
  },
  staged: {
    "*": "vp check --fix",
  },
  lint: {
    ignorePatterns: ["repos/**", "legacy/**", "dist/**", ".alchemy/**"],
    options: { typeAware: true, typeCheck: true },
  },
});
