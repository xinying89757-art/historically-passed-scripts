# 页面权限与 URL 当前运行器版本

来源：`output/ui-orchestrator/bug1004949/runner`。

与交付版本有差异；最新摘要 13 条中 9 通过、3 阻塞、1 产品确认。

## 安装与配置

有 lockfile 时执行 `npm ci`，否则执行 `npm install`。Node.js 22+；按脚本要求安装 Google Chrome 或 Playwright Chromium。

先阅读仓库根目录 README，配置自己的站点、测试内容、输入文件和凭据；源码与配置中的 `.example.invalid`、`YOUR_*`、`${ARCHIVE_WORKSPACE}` 都是待替换示例，不可作为真实目标。根目录 `tools/run-live.mjs` 会在配置未完成时明确报错。

复制 `fixtures/local-test-config.example.json` 为被 Git 忽略的 `fixtures/local-test-config.json`，填写测试角色信息，重新执行登录生成本机登录态。请使用临时测试内容替换 `registry/` 中历史产品和页面定位线索。

## 入口

```sh
npm run test:list
npm run test:unit
```

以上为原始入口示意；真实浏览器运行请通过根目录受检入口执行。离线测试参见根目录 `VALIDATION.md`。

## 历史证据与限制

见根目录 `evidence/` 和 `INVENTORY.md`。历史证据通常没有源码提交哈希；不能证明当前归档版本与当时执行版本完全一致。公开版仅调整路径、配置、隐私与入口检查，未重新执行真实环境。原说明保留在 `SOURCE-README.md`（存在时）。
