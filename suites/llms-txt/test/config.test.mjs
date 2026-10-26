import test from "node:test";
import assert from "node:assert/strict";
import { validateConfig } from "../src/config.mjs";

test("代理和登录地址配置有效", () => {
  const errors = validateConfig({
    loginUrl: "https://admin.example.invalid/website.html",
    proxy: { server: "http://proxy.example.invalid:8080" },
    browser: { viewport: { width: 1440, height: 900 } }
  });
  assert.deepEqual(errors, []);
});

test("拒绝缺少代理或无效地址", () => {
  assert.ok(validateConfig({ loginUrl: "", proxy: { server: "" }, browser: {} }).length >= 2);
});
