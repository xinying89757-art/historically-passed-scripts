import { defineConfig } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";

const resultsDir = path.resolve(process.env.UI_AUTOMATION_RESULTS_DIR ?? "results/current");
const storageState = process.env.UI_STORAGE_STATE || undefined;
const headless = process.env.HEADLESS === "1";
const proxyServer = process.env.UI_PROXY ?? "http://proxy.example.invalid:8080";
const proxy = proxyServer && !["none", "direct", "off"].includes(proxyServer.toLowerCase())
  ? { server: proxyServer }
  : undefined;
const sharedBrowserWsEndpoint = process.env.UI_BROWSER_WS_ENDPOINT || undefined;
const installedChromium = "input/LOCAL_FILE Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const browserExecutable = process.env.PLAYWRIGHT_EXECUTABLE_PATH ?? (fs.existsSync(installedChromium) ? installedChromium : undefined);

export default defineConfig({
  testDir: "./tests",
  testMatch: ["bug1004949-nonblocked.spec.ts", "scenario-setup.spec.ts", "recovery.spec.ts"],
  // Backend setup is always a separate one-worker process.  Only the
  // read-only verification process enables file-level parallelism.
  fullyParallel: process.env.UI_BACKEND_SETUP === "0",
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
    baseURL: process.env.UI_BASE_URL ?? "http://site.example.invalid",
    storageState,
    proxy,
    locale: "en-US",
    headless,
    connectOptions: sharedBrowserWsEndpoint ? { wsEndpoint: sharedBrowserWsEndpoint } : undefined,
    launchOptions: browserExecutable ? { executablePath: browserExecutable } : undefined,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
  },
});
