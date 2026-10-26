import test from "node:test";
import assert from "node:assert/strict";
import { TxtManagerPage } from "../src/txt-manager-page.mjs";

test("页面对象使用录制结果中的稳定语义定位器", () => {
  const fakeLocator = (details) => ({
    ...details,
    first() { return this; },
    last() { return this; },
    locator(selector) { return fakeLocator({ selector }); },
    or(other) { return { ...this, ...other }; }
  });
  const fakePage = {
    locator: (selector) => fakeLocator({ selector }),
    getByRole: (role, options) => fakeLocator({ role, options }),
    getByText: (text, options) => fakeLocator({ text, options })
  };
  const manager = new TxtManagerPage(fakePage);
  assert.equal(manager.settingsEntry().selector, ".backstage-siteTool-setting > .backstage-siteTool-inner");
  assert.deepEqual(manager.manageEntry().options, { name: /管理\s*txt\s*文件/u });
  assert.equal(manager.customTextarea().selector, ".llms-custom-content");
  assert.equal(manager.saveButton().selector, ".customize-file-footer .customize_file_llms_save:visible");
});
