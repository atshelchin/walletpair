import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/__tests__/live.test.ts"],
    testTimeout: 30000,
  },
});
