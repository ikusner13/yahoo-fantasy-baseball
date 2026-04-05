import { defineConfig } from "vite-plus";

export default defineConfig({
  build: {
    ssr: "src/index.tsx",
    outDir: "dist",
  },
  ssr: {
    target: "node",
  },
  test: {
    include: ["tests/**/*.test.ts"],
  },
  staged: {
    "*": "vp check --fix",
  },
  lint: { options: { typeAware: true, typeCheck: true } },
});
