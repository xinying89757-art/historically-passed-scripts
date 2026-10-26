import { test, expect } from "@playwright/test";

test.describe("BUG1004949 observed public navigation regressions", () => {
  test("用例-0030: first-party product link returns custom 404", async ({ page }) => {
    const response = await page.goto("/Lipstick-pl3021493.html", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    expect(response?.status()).toBe(404);
    await expect(page.getByText("The page you visited does not exist or the link is broken.", { exact: false })).toBeVisible();
  });

  test("用例-0036: source-defined product path returns custom 404", async ({ page }) => {
    const response = await page.goto("/chanpin.html", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    expect(response?.status()).toBe(404);
    await expect(page.getByText("The page you visited does not exist or the link is broken.", { exact: false })).toBeVisible();
  });
});
