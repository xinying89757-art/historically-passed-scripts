import { defineConfig } from "@playwright/test";

const proxyServer = process.env.UI_PROXY ?? "http://proxy.example.invalid:8080";
const proxy = proxyServer && !["none", "direct", "off"].includes(proxyServer.toLowerCase())
  ? { server: proxyServer }
  : undefined;

export default defineConfig({
  testDir: ".",
  testMatch: ["tests/scenario-setup.spec.ts", "tests/recovery.spec.ts"],
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 900_000,
  use: {
    storageState: process.env.UI_ADMIN_STORAGE_STATE ?? "fixtures/admin.storage.json",
    locale: "zh-CN",
    proxy,
    headless: process.env.HEADLESS !== "0",
  },
});
