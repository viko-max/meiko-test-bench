import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globals: false,
    // Offline by default: no network, no paid model calls.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
