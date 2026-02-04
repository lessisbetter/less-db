import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";

export default defineConfig({
  test: {
    include: ["bench/**/*.bench.ts"],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
    },
    benchmark: {
      include: ["bench/**/*.bench.ts"],
      outputJson: "bench/results.json",
    },
  },
});
