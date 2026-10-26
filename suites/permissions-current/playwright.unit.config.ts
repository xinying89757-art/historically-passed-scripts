import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "backend-state.unit.spec.ts",
  fullyParallel: true,
  workers: 1,
  retries: 0,
  reporter: "list",
});
