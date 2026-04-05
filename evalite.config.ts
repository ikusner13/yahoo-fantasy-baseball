import { defineConfig } from "evalite/config";

export default defineConfig({
  testTimeout: 120_000, // 2 min per eval (claude CLI can be slow)
  maxConcurrency: 3, // don't hammer claude CLI
});
