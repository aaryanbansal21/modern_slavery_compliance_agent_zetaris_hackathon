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
      // Pinned so routes set in .env don't leak into the model path test.
      MODEL_PLANNER: "meterless/auto",
      MODEL_PARSER: "meterless/fast",
      MODEL_CLASSIFIER: "meterless/fast",
      MODEL_DRAFTER: "meterless/auto",
      MODEL_EVALUATOR: "meterless/deep",
    },
  },
});
