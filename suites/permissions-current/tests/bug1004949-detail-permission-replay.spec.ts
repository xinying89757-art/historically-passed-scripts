import { test, expect } from "@playwright/test";

const protectedMessage = "The website you are visiting has password protection enabled, please enter the access password.";
const pagePassword = process.env.BUG1004949_PAGE_PASSWORD;

if (!pagePassword) {
  throw new Error("Set BUG1004949_PAGE_PASSWORD in the runtime environment; do not hardcode the page password in this script.");
}

const detailCases = [
  { id: "用例-0001", path: "/bug1004949/product.html", title: "product one" },
  { id: "用例-0002", path: "/bug1004949/article.html", title: "article one" },
];

test.describe("BUG1004949 detail-page password replay", () => {
  for (const detailCase of detailCases) {
    test(`${detailCase.id}: ${detailCase.path} password protection`, async ({ page }) => {
      await page.goto(`${detailCase.path}?replay=1`);
      await expect(page.getByText(protectedMessage, { exact: true })).toBeVisible();
      await expect(page.getByRole("textbox", { name: "Please enter a password" })).toBeVisible();

      await page.getByRole("textbox", { name: "Please enter a password" }).fill(pagePassword);
      await page.getByRole("button", { name: "OK" }).click();

      await expect(page.getByRole("textbox", { name: "Please enter a password" })).toHaveCount(0);
      await expect(page.getByText(detailCase.title, { exact: true })).toBeVisible();
    });
  }
});
