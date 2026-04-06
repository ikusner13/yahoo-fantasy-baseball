import { defineConfig } from "vite-plus";

export default defineConfig({
  build: {
    ssr: "src/worker.tsx",
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
  lint: { options: { typeAware: true, typeCheck: true } },
});
