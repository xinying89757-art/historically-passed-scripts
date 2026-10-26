# 脚本清单

| 套件 | 用途 | 来源 | 入口示例 | 历史证据与限制 |
|---|---|---|---|---|
| [block-page](suites/block-page/README.md) | 3.0/4.0 区块、组件、H 标签与增长引擎 | `block-page-automation` | `npm run plan` | 包含历史已完成和失败/待处理分支；按 evidence 中逐项状态判断。 [证据](evidence/block-page.json) |
| [editor-3](suites/editor-3/README.md) | 3.0 编辑器与 AI、产品描述、Markdown | `deliverables/leadong-3.0-block-automation` | `npm run plan` | AI 与产品流程存在通过和失败记录，保留完整套件。 [证据](evidence/editor-3.json) |
| [ai-block](suites/ai-block/README.md) | AI 区块独立交付版本 | `deliverables/leadong-ai-block-ui-automation` | `npm run ai:regression:status` | 来源 README 记载完整回归与专项通过，文章列表部分断言有局限。 [证据](evidence/ai-block.json) |
| [llms-txt](suites/llms-txt/README.md) | llms.txt 页面开关、保存、公开页验证 | `llms-txt-automation` | `npm test` | 来源 README 记载 32 通过、1 失败、3 条件跳过；不将所有用例视为通过。 [证据](evidence/llms-txt.json) |
| [phoenix](suites/phoenix/README.md) | 建站资料、设计审批及域名浏览器流程 | `automation/phoenix-design-flow` | `npm run flow -- --help` | 设计主流程和拒绝流程有完整无错记录；域名部分动作有成功记录，完整 full-flow 未找到无错记录。 [证据](evidence/phoenix.json) |
| [llms-registry](suites/llms-registry/README.md) | llms.txt 点位注册表版 Playwright Test | `automation/llms-txt-ui-automation-20260910/runner` | `npx playwright test --list` | 结果与注册表需按所选批次配置；原始环境与登录态不归档。 [证据](evidence/llms-registry.json) |
| [permissions](suites/permissions/README.md) | 页面权限、密码、会员、URL 回归交付版本 | `outputs/BUG1004949-reusable-runner-20260916` | `npm run test:list` | 历史全量 40 条：35 通过、1 业务失败、3 环境阻塞、1 产品确认。 [证据](evidence/permissions.json) |
| [permissions-current](suites/permissions-current/README.md) | 页面权限与 URL 当前运行器版本 | `output/ui-orchestrator/bug1004949/runner` | `npm run test:list` | 与交付版本有差异；最新摘要 13 条中 9 通过、3 阻塞、1 产品确认。 [证据](evidence/permissions-current.json) |
| [backend-setup](suites/backend-setup/README.md) | 权限回归后台准备与恢复依赖 | `outputs/BUG1004949-content-backend-20260916` | `npx playwright test --list` | 作为已验证权限流程的准备/恢复依赖收录，不单独宣称全套通过。 [证据](evidence/backend-setup.json) |
| [admin-login](suites/admin-login/README.md) | 管理员独立登录历史版本 | `outputs/BUG1004949-admin-login-20260916` | `npm run login` | 来源文档记载登录流程，且为历史权限运行所需依赖。 [证据](evidence/admin-login.json) |
| [login-assets](suites/login-assets/README.md) | 管理员登录资产版本 | `outputs/BUG1004949-login-assets-20260921` | `npm run login` | 与旧版本代码有差异，来源文档及权限/编辑器历史流程可追溯。 [证据](evidence/login-assets.json) |
| [login-portable](suites/login-portable/README.md) | 独立可携带的 Chrome 登录流程 | `deliverables/leadong-playwright-login` | `npm run login` | 提取自已使用的 AI UI 自动化流程；没有独立同版本运行哈希。 [证据](evidence/login-portable.json) |
| [v4-portable](suites/v4-portable/README.md) | 4.0 区块与 H2 独立交付版本 | `portable-packages/v4-block-h2-automation` | `npm run check` | 来源交付说明与区块套件历史验证；原数据改为自备模板。 [证据](evidence/v4-portable.json) |
| [faq-replay](suites/faq-replay/README.md) | FAQ 创建、排序、删除、样式 CLI 回放 | `work/faq-ui-pilot` | `bash run_first_batch.sh` | 历史首批 3 项通过；依赖已有浏览器会话与已打开的 FAQ/前台页。 [证据](evidence/faq-replay.json) |
| [source-channel](suites/source-channel/README.md) | 来源渠道浏览器访问与埋点验证 | `outputs/source_channel_test_data` | `node run_source_channel_visits.mjs --input input/cases.xlsx --no-proxy` | 有浏览器访问成功记录；不代表来源渠道归因后台均已通过。依赖外部 artifact-tool 运行时。 [证据](evidence/source-channel.json) |

所有来源路径均相对于原工作文件夹。时间与通过数属于历史记录；没有把失败/阻塞结果转成通过，也没有将后续代码修改视为已验证。

LLMS 注册表批次的原始校验摘要为 63 条：32 通过、8 自动化失败、23 环境阻塞；这与独立 llms-txt 套件 README 的历史 36 条批次口径不同，需分别阅读证据。
