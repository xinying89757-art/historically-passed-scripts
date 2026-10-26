# 依赖和输入要求

## 标准 Node.js 依赖

进入具体套件后安装，不需要在仓库根目录安装所有套件。存在锁文件使用 `npm ci`，其余使用 `npm install`。原套件依赖版本保留；区块套件补充声明源码已使用的 `xlsx@0.18.5`。本次校验不下载浏览器，不访问真实测试环境。

Node.js 22+；`import.meta.dirname` 等用法不适用于过旧 Node。浏览器入口按套件使用 Chrome 或 `npx playwright install chromium`。FAQ 回放还需 `@playwright/cli` 或已有 CLI 包装脚本，通过 `PWCLI` 指定可执行文件；权限 Shell 回放通过 `UI_PLAYWRIGHT_CLI_CONFIG` 指定本机 CLI 配置。

## 外部 artifact-tool 运行时

以下历史源文件直接导入 `@oai/artifact-tool`：

- `suites/permissions-current/support/artifact-runtime/update-final-0017.mjs`
- `suites/permissions-current/support/artifact-runtime/write-results-xlsx.mjs`
- `suites/permissions-current/support/artifact-runtime/verify-full-results-xlsx.mjs`
- `suites/permissions-current/support/artifact-runtime/verify-results-xlsx.mjs`
- `suites/permissions-current/support/artifact-runtime/write-full-results-xlsx.mjs`
- `suites/permissions/support/artifact-runtime/update-final-0017.mjs`
- `suites/permissions/support/artifact-runtime/write-results-xlsx.mjs`
- `suites/permissions/support/artifact-runtime/verify-results-xlsx.mjs`
- `suites/block-page/scripts/build-onpage-v3-history-h-seo-xlsx.mjs`
- `suites/block-page/scripts/build-v3-origin-mismatch-summary.mjs`
- `suites/block-page/scripts/build-v3-page-confirmation-xlsx.mjs`
- `suites/block-page/scripts/build-onpage-v3-tdk-dual-xlsx.mjs`
- `suites/block-page/scripts/build-onpage-v3-tdk-regression-xlsx.mjs`
- `suites/block-page/scripts/build-onpage-v3-history-regression-xlsx.mjs`
- `suites/block-page/src/growth-engine-h-v3-supplement-audit.mjs`
- `suites/block-page/src/v3-page-address-confirmation.mjs`
- `suites/block-page/src/v3-online-input.mjs`
- `suites/block-page/src/growth-engine-h-v4-current-audit.mjs`
- `suites/block-page/src/growth-engine-h-v4-supplement-audit.mjs`
- `suites/block-page/src/ranking-input.mjs`
- `suites/block-page/src/growth-engine-h-v3-current-audit.mjs`
- `suites/block-page/src/component-input.mjs`
- `suites/block-page/src/growth-engine-h-v3-readonly-recheck.mjs`
- `suites/block-page/src/growth-engine-h-v3-online-audit.mjs`
- `suites/source-channel/run_source_channel_visits.mjs`

此模块由原工作环境提供，未将内部依赖复制到公开仓库，不能承诺公开 npm 能安装。拥有该运行时的使用者可将可用模块连接或安装到对应套件 `node_modules`；只把 `UI_ARTIFACT_NODE` 设置为另一 Node 路径并不能解决模块解析问题。权限运行器默认改用当前 `process.execPath`，可由 `UI_ARTIFACT_NODE` 覆盖。

运行依赖它的入口前，执行 `node --input-type=module -e "await import('@oai/artifact-tool')"` 验证模块可解析。不满足时应使用其他独立入口；本次不宣称这些命令可在普通 npm 环境完整运行。

## 自备测试输入

真实 CSV/XLSX/业务 JSON 清单不分发。区块套件需要自己的区块 CSV、组件 XLSX、排名 XLSX、上线状态表和按功能选择的区块 JSON；结构与列名以相应 `src/*input*.mjs` 为准，配置路径位于 `config/`。若需复用原组件/模板 ID，请在目标站点确认这些模板可用。

AI 输入图片请使用自己有权使用的测试图片；HTML 上传的合成示例页面保留在 `fixtures/html-upload/`。

权限套件的 XLSX 报告写入要求自备源表：`测试用例!A5:A44` 为 40 个唯一 `用例-xxxx` 编号，J/K 列写入状态/原因；通过 `UI_CASE_SOURCE_XLSX` 指定源文件。测试编号、原文和源表须对应，不能随意用无关工作簿替换。

来源渠道脚本需要三张表：`测试数据与预期结果`、`统计概览`、`规则说明`。明细表第 4 行 A:T 为：用例ID、qa_run、qa_case、测试套件、测试场景、目标URL、URL参数、Referrer、本站域名、预期来源渠道、命中优先级、预期命中规则、测试目的、数据来源、是否探针、是否核心用例、执行状态、实际渠道、通过状态、失败原因。数据从第 5 行开始；用 `--last-data-row` 指定末行，`--input` 指向自己的工作簿。浏览器访问证据不能独立证明后台归因正确。

## 本机凭据与配置

权限套件复制 `fixtures/local-test-config.example.json` 为 `fixtures/local-test-config.json`；管理员登录套件复制 `config/admin-login.example.json` 为 `config/admin-login.json`。文件已被 `.gitignore` 排除。所有登录态重新生成。

`${ARCHIVE_WORKSPACE}`、`input/LOCAL_FILE`、`.example.invalid`、`YOUR_*` 表示已移除的本机/业务值，按自己的测试环境配置或替换。历史产品 ID 和页面定位线索需在自己的数据中建立后再运行。
