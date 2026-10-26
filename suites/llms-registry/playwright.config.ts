import { defineConfig } from "@playwright/test";
import path from "node:path";

const resultsDir = path.resolve(process.env.UI_AUTOMATION_RESULTS_DIR ?? "results/current");
const storageState = process.env.UI_STORAGE_STATE || undefined;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: Number(process.env.UI_AUTOMATION_WORKERS ?? "1"),
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  outputDir: path.join(resultsDir, "artifacts"),
  reporter: [
    ["json", { outputFile: path.join(resultsDir, "playwright-results.json") }],
    ["html", { outputFolder: path.join(resultsDir, "playwright-report"), open: "never" }],
  ],
  use: {
    baseURL: process.env.UI_BASE_URL,
    storageState,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
  },
});
