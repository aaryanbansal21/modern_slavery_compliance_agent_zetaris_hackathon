import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    env: {
      DATA_DIR: ".data-test",
      REF_FETCHED_DIR: ".data-test/no-fetched-lists",
      AI_MODE: "mock",
      DATA_MODE: "local",
      ASSESSMENT_DATE: "2026-10-23",
      LLM_CACHE: "off",
      WORLD_NAMESPACE: "test",
    },
  },
});
