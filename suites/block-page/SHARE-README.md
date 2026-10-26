# 领动自动化脚本复用包

本包用于在 macOS 或 Windows 上，通过 Playwright 操作领动 3.0/4.0 编辑器和增长引擎。

## 1. 环境准备

- Node.js 20 或更高版本；
- 已安装并可启动的 Google Chrome；
- 可访问测试环境的网络或代理；
- 在包根目录执行：

```bash
npm ci
```

macOS 支持自动把浏览器窗口最小化。Windows 会正常执行流程，但不提供这个 macOS 专用能力。

## 2. 放置清单并修改配置

把 CSV、Excel 或 JSON 清单放入 `input/`，参考 `input/README.md`。

再编辑 `config/` 中对应 JSON，至少填写：站点名称、语言、正式域名、编辑器入口、输入文件路径和代理地址。所有路径建议使用相对路径。

## 3. 推荐执行顺序

每个任务都按以下顺序执行：

```text
auth → plan → POC试跑 → status → 全量run → 中断时resume → report
```

其中：

- `plan`、`probe`、`status`、`report` 和只读核查不会修改网站；
- `run`、`add`、`prepare`、同步类命令会修改网站，必须显式带 `--apply`；
- `publish` 会发布网站，默认不要执行。

开始全量写入前，建议先执行 POC 并人工确认页面和区块顺序。

## 4. 3.0 普通区块

读取区块 CSV，在 3.0 自定义页面中按每页 6 个添加区块，保存、重开并核对区块 ID；支持断点恢复和发布前校验。

```bash
npm run plan
npm run auth
npm run probe
npm run run:poc
npm run run
npm run recover:save
# 只有确认需要发布时才执行
npm run publish -- --apply --confirm-site YOUR_SITE_HOST
```

## 5. 3.0 组件

读取组件 Excel，添加组件并设置中文组件标题/H2；特殊代码组件和富文本组件使用专用重试流程。

```bash
npm run component:plan
npm run component:run:poc
npm run component:run
npm run component:resume
npm run component:status
npm run component:retry
npm run component:retry:not-found
npm run component:retry:custom-code
npm run component:retry:rich-text
```

## 6. 3.0 区块排名

根据排名 Excel 添加区块并按模板设置 H2，可探测模板入口、单区块重试并生成报告。

```bash
npm run ranking:plan
npm run ranking:probe:templates
npm run ranking:run:poc
npm run ranking:run
npm run ranking:resume
npm run ranking:status
npm run ranking:h:report
```

## 7. 4.0 区块

读取新版编辑器 CSV，添加图片集和图文区块，按每页 10 个分组；支持代理环境、页面保存、重开和恢复。

```bash
npm run v4-block-plan
npm run v4-block-auth
npm run v4-block-probe
npm run v4-block-run
npm run v4-block-resume
npm run v4-block-status
```

## 8. 4.0 富文本

在已添加的 4.0 区块中定位富文本设置，写入测试文字并设置 H2，重新打开验证回填；不支持富文本的区块单独记录。

```bash
npm run v4:h:inventory
npm run v4:h:prepare
npm run v4:h:resume
npm run v4:h:status
npm run v4:h:report
npm run v4:h:batch:plan
npm run v4:h:batch:run:poc
npm run v4:h:batch:run
npm run v4:h:batch:resume
```

## 9. 增长引擎 3.0

在增长引擎中搜索页面、等待扫描结果稳定、读取 H 设置、修改可编辑字段、保存并同步，然后使用正式域名自动拼接的预览地址验证页面和 3.0 编辑器回填。本复用包默认不点击刷新按钮，也不依赖增长引擎中的预览链接。增长引擎批量流程还支持组件页/区块页范围选择。

```bash
npm run ge:h:auth
npm run ge:h:plan
npm run ge:h:run:poc
npm run ge:h:resume
npm run ge:h:status
npm run ge:h:report
npm run ge:h:batch:plan
npm run ge:h:batch:run:poc
npm run ge:h:batch:run
npm run ge:h:batch:resume
```

3.0 历史只读回归、当前归属核查和预览地址试跑命令也已保留，详见 `AUTOMATION-SCRIPT-INVENTORY.md`。

## 10. 增长引擎 4.0

读取 4.0 富文本状态，在增长引擎中等待扫描结果稳定后修改可映射 H，使用正式域名自动拼接的预览地址验证，并检查 4.0 编辑器回填。本复用包默认不点击刷新按钮，也不读取旧预览链接。

```bash
npm run ge:v4:h:auth
npm run ge:v4:h:plan
npm run ge:v4:h:run:poc
npm run ge:v4:h:resume
npm run ge:v4:h:status
npm run ge:v4:h:report
npm run ge:v4:h:batch:plan
npm run ge:v4:h:batch:run
npm run ge:v4:h:batch:resume
```

如果需要显式使用无刷新批次：

```bash
npm run ge:v4:h:no-refresh:plan
npm run ge:v4:h:no-refresh:run:poc
npm run ge:v4:h:no-refresh:batch:run:poc
npm run ge:v4:h:no-refresh:batch:run
npm run ge:v4:h:no-refresh:batch:resume
```

该批次等待页面重新加载后的扫描结果稳定，并按正式域名自动拼接预览地址；无法推导地址时记录 `preview_unresolved`，不会静默回退到旧预览地址。

## 11. 只读核查

只读核查只判断 H 文字和级别是否可以编辑，不修改任何数据，不点击“保存并同步”，不发布网站。

```bash
npm run ge:v3:h:readonly-recheck:plan
npm run ge:v3:h:readonly-recheck:run
npm run ge:v3:h:readonly-recheck:status
npm run ge:v3:h:readonly-recheck:report

npm run ge:v4:h:audit:plan
npm run ge:v4:h:audit:run
npm run ge:v4:h:audit:status
npm run ge:v4:h:audit:report
```

还可使用 `ge:v3:h:current-audit:*`、`ge:v3:h:supplement:*`、`ge:v4:h:current-audit:*` 和 `ge:v4:h:supplement:*` 进行按区块归属的补充核查。

## 12. 登录、恢复和结果

每个模块都使用独立的浏览器登录目录。换电脑时不要复制 `.auth/`，重新执行对应 `auth` 并人工登录。

中断后使用对应的 `resume`，不要用新的 `run` 覆盖已有任务。结果保存在本机 `.state/`、`reports/` 和 `artifacts/`，这些目录不包含在复用包中，会在第一次运行时自动创建。

## 13. 安全检查

执行写入命令前确认：当前浏览器站点、语言、页面名称和域名都正确。先跑 `plan` 和 POC，再执行全量任务。发布命令必须人工确认后执行。
