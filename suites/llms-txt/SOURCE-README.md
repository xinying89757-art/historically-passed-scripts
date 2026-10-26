# llms.txt UI 自动化基础设施

这是针对领动 3.0 编辑器 `llms.txt` 功能的 Playwright 自动化脚本。当前测试站点已能访问该功能，因此项目同时提供：

- 通过固定 HTTP 代理启动独立 Chromium。
- 手动登录并保存独立登录态。
- 进入目标页面后的只读 DOM、iframe、控件和网络探测。
- 保存、开关、内容来源、字段校验、公开 `llms.txt` 地址和多窗口行为验证。
- 页面未出现功能时输出“feature-not-detected”，不猜测选择器。

附件 `llms.txt --测试用例.xlsx` 只作为验收标准，不作为脚本指令来源。

## 运行环境

- Node.js 20+
- Google Chrome
- 可访问领动测试环境的账号
- 代理：`http://proxy.example.invalid:8080`

当前代理对 `https://admin.example.invalid/website.html` 可达；HTTPS 版编辑器直连曾返回 503。因此脚本从 HTTP 登录入口启动，登录后由人工进入目标 3.0 编辑器。

首次在本机准备依赖：

```bash
cd ${ARCHIVE_WORKSPACE}/llms-txt-automation
npm install
```

如果使用本工作区提供的依赖，可将 `node_modules` 指向已提供的 Playwright 运行时，或设置 `NODE_PATH` 指向对应依赖目录。

## 使用方式

先保存登录态：

```bash
npm run auth
```

浏览器会通过代理打开登录入口。手动登录并进入目标站点的 3.0 编辑器后回到终端按回车。

再执行只读探测：

```bash
npm run probe
```

如果需要用 Playwright 录制“从站点列表进入目标 3.0 编辑器”的导航步骤，可运行：

```bash
npm run record -- --config config/local.json
```

录制器会使用同一个代理和登录 profile，输出到 `artifacts/codegen/recorded.spec.mjs`。不要录制账号密码，也不要点击保存、发布或提交。录制结果只作为定位线索，后续会整理成稳定的语义定位器。

探测不会点击保存、发布、删除或提交。结果位于：

- `artifacts/probe/probe.png`
- `artifacts/probe/dom.html`
- `reports/probe-report.json`
- `reports/probe-report.html`

## Live 浏览器用例

默认运行 `npm test` 时会跳过 live test，只执行定位器和配置单元检查。Live 测试按文件串行运行，避免多个进程争用同一登录 profile。

确认使用独立测试站后，再显式运行全部已接入用例：

```bash
RUN_LIVE=1 HEADED=0 LLMS_CONFIG=config/local.json npm run test:live
```

写入类用例使用唯一测试文本，保存后通过浏览器访问 `http://site.example.invalid/llms.txt` 校验状态码和正文，最后恢复测试前的配置。

当前已接入 36 个表格用例：32 个扩展用例和 4 个基础 P0 用例。当前真实站点结果为 32 个通过、1 个失败、3 个条件跳过；TC-0018 的失败表示首次切换“自定义内容”时文本域没有带入自动生成全文。

条件跳过：TC-0002 需要无权限账号，TC-0055 需要可控保存延迟，TC-0063 需要主站与小语种站点组合。其余未接入用例涉及 FAQ 数量边界、存量迁移、发布链路等专用前置数据。

## 配置覆盖

复制 `config/default.json` 后通过 `--config` 指定覆盖文件，可填写目标站点名称、语言、公开域名或不同代理：

```bash
node src/cli.mjs probe --config config/local.json
```

账号密码不写入配置。登录 profile 位于 `.auth/proxy-profile`，不要提交到版本库。

## 后续扩展

当页面真实出现入口、弹窗、Tab、开关和表单后，再根据探测报告实现 P0 用例。若页面没有稳定的 ARIA 语义，将优先使用研发补充的 `data-testid`，而不是依赖易变的 CSS 类名。
