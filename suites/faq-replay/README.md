# FAQ 创建、排序、删除、样式 CLI 回放

来源：`work/faq-ui-pilot`。

历史首批 3 项通过；依赖已有浏览器会话与已打开的 FAQ/前台页。

## 安装与配置

有 lockfile 时执行 `npm ci`，否则执行 `npm install`。Node.js 22+；按脚本要求安装 Google Chrome 或 Playwright Chromium。

先阅读仓库根目录 README，配置自己的站点、测试内容、输入文件和凭据；源码与配置中的 `.example.invalid`、`YOUR_*`、`${ARCHIVE_WORKSPACE}` 都是待替换示例，不可作为真实目标。根目录 `tools/run-live.mjs` 会在配置未完成时明确报错。

需要 `@playwright/cli` 或原 Playwright CLI 包装脚本；通过 `PWCLI` 指定可执行文件。先自行登录并打开 FAQ 产品编辑页和对应前台页，执行回放会修改 FAQ 后恢复。此包不负责创建这些前置页面。

## 入口

```sh
bash run_first_batch.sh
```

以上为原始入口示意；真实浏览器运行请通过根目录受检入口执行。离线测试参见根目录 `VALIDATION.md`。

## 历史证据与限制

见根目录 `evidence/` 和 `INVENTORY.md`。历史证据通常没有源码提交哈希；不能证明当前归档版本与当时执行版本完全一致。公开版仅调整路径、配置、隐私与入口检查，未重新执行真实环境。原说明保留在 `SOURCE-README.md`（存在时）。
