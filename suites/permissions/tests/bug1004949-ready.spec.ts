import { test, expect } from "@playwright/test";
import { createPointRuntime } from "../support/point-runtime.js";

const protectedPath = "/bug1004949/article.html";
const protectedMessage = "The website you are visiting has password protection enabled, please enter the access password.";

test.describe("BUG1004949 English site ready batch", () => {
  test("用例-0005: protected URL returns password page three times", async ({ page }) => {
    const runtime = createPointRuntime(page);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await page.goto(protectedPath);
      await page.waitForTimeout(1500);
      await runtime.expectPoint("english-site.protected.protected-entry.region").visible();
      await runtime.expectPoint("english-site.protected.password-input.input").visible();
    }
  });

  test("用例-0008: unverified protected URL shows password input", async ({ page }) => {
    const runtime = createPointRuntime(page);
    await page.goto(protectedPath);
    await page.waitForTimeout(1500);
    await runtime.expectPoint("english-site.protected.protected-entry.region").visible();
    await runtime.expectPoint("english-site.protected.password-input.input").visible();
    await expect(page.getByText(protectedMessage, { exact: true })).toBeVisible();
  });

  test("用例-0022: system custom URL parameter does not bypass password protection", async ({ page }) => {
    const runtime = createPointRuntime(page);
    await page.goto(`${protectedPath}?_systemCustomUrl_=1`);
    await page.waitForTimeout(1500);
    await runtime.expectPoint("english-site.protected.password-input.input").visible();
    await expect(page).toHaveURL(/_systemCustomUrl_=1/u);
  });

  test("用例-0023: real request URL parameter preserves password protection", async ({ page }) => {
    const runtime = createPointRuntime(page);
    await page.goto(`${protectedPath}?foo=1&_realRequestUrl_=%2Fbug1004949%2Farticle.html`);
    await page.waitForTimeout(1500);
    await runtime.expectPoint("english-site.protected.password-input.input").visible();
    await expect(page).toHaveURL(/foo=1/u);
    await expect(page).toHaveURL(/_realRequestUrl_=/u);
  });

  test("用例-0024: direct system custom URL parameters cannot show protected content", async ({ page }) => {
    const runtime = createPointRuntime(page);
    await page.goto(`/system_custom_url?_systemCustomUrl_=1&_realRequestUrl_=%2Fbug1004949%2Farticle.html`);
    await page.waitForTimeout(1500);
    await runtime.expectPoint("english-site.error.not-found.region").visible();
    await expect(page.getByText("article one", { exact: true })).toHaveCount(0);
  });

  test("用例-0025: direct protected page shows only password entry", async ({ page }) => {
    const runtime = createPointRuntime(page);
    await page.goto(protectedPath);
    await page.waitForTimeout(1500);
    await runtime.expectPoint("english-site.protected.password-input.input").visible();
    await expect(page.getByText("article one", { exact: true })).toHaveCount(0);
  });

  test("用例-0027: refreshing an unverified protected URL keeps the password page", async ({ page }) => {
    const runtime = createPointRuntime(page);
    await page.goto(protectedPath);
    await page.waitForTimeout(1500);
    await runtime.expectPoint("english-site.protected.password-input.input").visible();
    await page.reload();
    await page.waitForTimeout(1500);
    await runtime.expectPoint("english-site.protected.password-input.input").visible();
  });

  test("用例-0043: nonexistent directory URL shows the custom 404 page", async ({ page }) => {
    const runtime = createPointRuntime(page);
    await page.goto("/tests/nonexistent-bug1004949.html");
    await page.waitForTimeout(1500);
    await runtime.expectPoint("english-site.error.not-found.region").visible();
    await expect(page).toHaveURL(/\/tests\/nonexistent-bug1004949\.html$/u);
  });
});
