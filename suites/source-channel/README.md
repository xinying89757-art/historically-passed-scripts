# 来源渠道浏览器访问与埋点验证

来源：`outputs/source_channel_test_data`。

有浏览器访问成功记录；不代表来源渠道归因后台均已通过。依赖外部 artifact-tool 运行时。

## 安装与配置

有 lockfile 时执行 `npm ci`，否则执行 `npm install`。Node.js 22+；按脚本要求安装 Google Chrome 或 Playwright Chromium。

先阅读仓库根目录 README，配置自己的站点、测试内容、输入文件和凭据；源码与配置中的 `.example.invalid`、`YOUR_*`、`${ARCHIVE_WORKSPACE}` 都是待替换示例，不可作为真实目标。根目录 `tools/run-live.mjs` 会在配置未完成时明确报错。

此历史脚本额外依赖工作环境提供的 `@oai/artifact-tool`（包含 XLSX 导入、导出、检查和渲染）。该内部运行时未打包、也不假定可从公开 npm 安装；如已获得可用模块目录，可执行 `npm install /绝对路径/artifact-tool` 连接本机运行时。输入表结构见 `INPUTS.md`。此依赖缺失时不能执行完整流程，本次只进行语法检查。

## 入口

```sh
node run_source_channel_visits.mjs --input input/cases.xlsx --no-proxy
```

以上为原始入口示意；真实浏览器运行请通过根目录受检入口执行。离线测试参见根目录 `VALIDATION.md`。

## 历史证据与限制

见根目录 `evidence/` 和 `INVENTORY.md`。历史证据通常没有源码提交哈希；不能证明当前归档版本与当时执行版本完全一致。公开版仅调整路径、配置、隐私与入口检查，未重新执行真实环境。原说明保留在 `SOURCE-README.md`（存在时）。
