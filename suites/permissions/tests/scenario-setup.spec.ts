import { test } from "@playwright/test";
import { BackendStateManager } from "../support/backend-state.js";
import { adminStorageState, proxyUrl } from "../support/bug1004949-config.js";

test("BUG1004949 scenario setup", async ({ browser }) => {
  const group = process.env.UI_SCENARIO_GROUP;
  if (!group) throw new Error("UI_SCENARIO_GROUP is required for scenario setup");
  test.setTimeout(900_000);
  const context = await browser.newContext({ storageState: adminStorageState, locale: "zh-CN", proxy: { server: proxyUrl } });
  const page = await context.newPage();
  try {
    const manager = new BackendStateManager();
    await manager.captureBaseline(process.env.UI_BASELINE_FILE ?? "");
    await manager.prepareScenarioGroup(page, group);
  } finally {
    await context.close();
  }
});
