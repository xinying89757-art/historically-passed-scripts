# 自动化脚本清单

本清单对应当前目录 `${ARCHIVE_WORKSPACE}/block-page-automation`。

## 先看这几个规则

- `plan`、`probe`、`status`、`report`：只读或生成报告，一般不会改网站。
- `auth`：打开独立浏览器配置，由人工登录；登录状态保存在 `.auth/`，不要复制给其他人。
- `run`、`add`、`prepare`、`ranking-run` 等写入命令：只有带 `--apply` 才允许修改网站。
- 3.0、4.0、增长引擎不同批次使用独立状态文件和配置，不能混用配置。
- 恢复中断优先使用对应的 `resume`，不要把新的 `run` 当成恢复命令。
- 当前脚本默认单浏览器写入，不建议同时启动两个写入任务。

## 一、3.0 编辑器：区块铺设

### 1. 普通区块铺页（最早的通用任务）

入口：`src/cli.mjs`、`src/runner.mjs`、`src/editor.mjs`

功能：读取 CSV 中的区块 ID，在 3.0 自定义页面中按每页 6 个添加；搜索时输入 ID 并回车，等待结果，悬浮卡片后点击添加；页面满 6 个后保存并重开校验；中断可恢复；可单独发布并校验公开页面。

常用命令：

```bash
npm run plan
npm run auth
npm run probe
npm run run:poc
npm run run
npm run recover:save
npm run publish -- --apply --confirm-site HOST
```

说明：`run:poc` 是小流量试跑；`run` 是全量写入；`publish` 会发布，只有明确需要发布时才使用。

### 2. 3.0 组件添加和组件标题 H2

入口：`src/component-runner.mjs`、`src/component-editor.mjs`、`src/component-input.mjs`

功能：从 Excel 的 3.0“组件”清单提取组件，跳过详情组件和明确不支持项；新建页面、每页最多 6 个组件；按组件名称搜索、添加；打开组件设置，设置中文组件标题和 H2；页面保存、重开、回填验证；失败项可重试。

常用命令：

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
npm run component:relocate-countdown -- --apply
```

其中：

- `component:retry:custom-code`：处理插件代码、在线客服、VR、社交插件等代码型组件，写入多个 H2 代码标签。
- `component:retry:rich-text`：处理图文页签、公告、倒计时等富文本弹窗。
- `component:relocate-countdown`：仅用于倒计时组件页面位置修复，属于定向修复命令。

### 3. 区块排名清单对应的 3.0 区块/H 标签

入口：`src/ranking-heading-poc.mjs`、`src/ranking-template-probe.mjs`、`src/ranking-heading-report.mjs`

功能：依据“区块排名”清单添加区块，并按模板设置富文本 H2；支持按模板探测设置入口、单区块重试、状态和报告。

```bash
npm run ranking:plan
npm run ranking:probe:templates
npm run ranking:run:poc
npm run ranking:run
npm run ranking:resume
npm run ranking:retry:block -- --block-id 23274
npm run ranking:status
npm run ranking:h:report
```

### 4. 3.0 全量当前区块（“拉取区块”JSON）

入口：`src/v3-full-cli.mjs`、`src/v3-full-runner.mjs`、`src/v3-full-heading-runner.mjs`

功能：读取 10 类 JSON，按排除规则去重，识别已有映射；缺失区块添加到新页面；已添加区块设置或核验富文本 H2；支持快速模式、定向重试、断点恢复和最终报告。

```bash
npm run v3:full:plan
npm run v3:full:auth
npm run v3:full:add:poc
npm run v3:full:add
npm run v3:full:resume
npm run v3:full:h:poc
npm run v3:full:h:run
npm run v3:full:h:resume
npm run v3:full:h:resume:fast
npm run v3:full:h:retry:fast
npm run v3:full:status
npm run v3:full:report
npm run v3:full:final-report
```

### 5. 3.0“上线”状态区块

入口：`src/v3-online-cli.mjs`、`src/v3-online-input.mjs`、`src/v3-online-report.mjs`

功能：读取“上线”工作表，在人工选择的 3.0 网站上添加区块并设置 H2；网站名称、语言、域名和编辑器地址由 `auth` 记录，不硬编码；支持恢复和报告。

```bash
npm run v3:online:plan
npm run v3:online:auth
npm run v3:online:run -- --apply
npm run v3:online:resume -- --apply
npm run v3:online:retry -- --apply
npm run v3:online:status
npm run v3:online:report
```

## 二、4.0 编辑器：区块铺设与富文本测试数据

### 6. 4.0 图片集/图文区块铺页

入口：`src/v4-cli.mjs`、`src/v4-runner.mjs`、`src/v4-editor.mjs`

功能：读取新版编辑器 CSV，筛选图片集和图文，按每页 10 个分开铺设；通过画布“添加一个新区块”、侧边栏搜索、结果卡片点击添加；保存、重开和区块 ID 顺序核对；支持代理配置。

```bash
npm run v4-block-plan
npm run v4-block-auth
npm run v4-block-probe
npm run v4-block-run
npm run v4-block-resume
npm run v4-block-retry
npm run v4-block-status
```

### 7. 4.0 单页/批量富文本 H2 测试数据

入口：`src/v4-rich-text-cli.mjs`、`src/v4-rich-text-setup.mjs`、`src/v4-rich-text-batch-cli.mjs`、`src/v4-rich-text-batch.mjs`

功能：打开已添加的 4.0 区块，悬浮图片并进入编辑设置；识别带富文本编辑器的输入区；设置唯一中文文字和 H2；重新打开验证回填。批量版本按页面处理多个区块，记录不支持富文本和异常。

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
npm run v4:h:batch:status
```

### 8. 4.0 无代理镜像/补充页面

入口：`src/v4-mirror-cli.mjs`、`src/v4-mirror.mjs`

功能：在不挂代理的 4.0 环境中，将已有代理环境的页面/区块清单重新铺设或核对，用于验证环境隔离；也能从已有页面状态继续处理。

```bash
npm run v4:mirror:plan
npm run v4:mirror:auth
npm run v4:mirror:run:poc
npm run v4:mirror:run
npm run v4:mirror:resume
npm run v4:mirror:status
npm run v4:mirror:report
```

## 三、增长引擎：H 标签修改、预览和回填验证

### 9. 单页面 3.0 H 标签同步试跑（当前已改造预览地址）

入口：`src/growth-engine-h-cli.mjs`、`src/growth-engine-h-editor.mjs`、`src/preview-url-resolver.mjs`

功能：在增长引擎搜索页面路径；等待扫描结果稳定；读取所有 H 设置项；修改可编辑文字和级别；保存并同步；根据正式域名自动生成 `.preview.leadong.com` 预览地址；验证预览 DOM；进入 3.0 编辑器检查设置回填。

当前 `/001.html` 试跑配置：`config/growth-engine-h-v3-preview-pilot.json`。

```bash
npm run ge:h:v3:preview:plan
npm run ge:h:v3:preview:auth
npm run ge:h:v3:preview:run
npm run ge:h:v3:preview:resume
npm run ge:h:v3:preview:status
npm run ge:h:v3:preview:report
```

该批次最近一次状态为 `complete`，6 个 H 标签已完成增长引擎修改、预览验证和 3.0 编辑器回填验证。

### 10. 增长引擎 3.0/组件/区块批量同步

入口：`src/growth-engine-h-batch-cli.mjs`、`src/growth-engine-h-batch.mjs`

功能：从组件铺页状态和区块排名状态生成页面任务；按页面处理；增长引擎修改所有可编辑 H；预览验证；进入 3.0 编辑器检查组件标题/富文本回填；支持按 `components` 或 `blocks` 范围运行。

```bash
npm run ge:h:batch:plan
npm run ge:h:batch:run:poc
npm run ge:h:batch:run
npm run ge:h:batch:resume
npm run ge:h:batch:editor-check
npm run ge:h:batch:status
```

### 11. 增长引擎 4.0 H 标签同步

入口：`src/growth-engine-h-v4-cli.mjs`、`src/growth-engine-h-v4-run.mjs`、`src/growth-engine-h-v4-source.mjs`

功能：读取 4.0 富文本准备状态；在增长引擎修改可唯一映射的 H；同步后验证预览；回到 4.0 编辑器检查富文本回填；支持按页面恢复。

```bash
npm run ge:v4:h:auth
npm run ge:v4:h:plan
npm run ge:v4:h:run:poc
npm run ge:v4:h:resume
npm run ge:v4:h:status
npm run ge:v4:h:report
```

批量版本：

```bash
npm run ge:v4:h:batch:plan
npm run ge:v4:h:batch:run
npm run ge:v4:h:batch:resume
npm run ge:v4:h:batch:status
npm run ge:v4:h:batch:reconcile
npm run ge:v4:h:batch:report
```

复用包中的增长引擎流程默认使用无刷新配置。该流程只等待页面扫描结果稳定，并根据正式域名自动生成 `preview.leadong.com` 预览地址，不点击刷新、不读取增长引擎中的预览链接，也不覆盖历史状态：

```bash
npm run ge:v4:h:no-refresh:plan
npm run ge:v4:h:no-refresh:run:poc
npm run ge:v4:h:no-refresh:batch:plan
npm run ge:v4:h:no-refresh:batch:run:poc
npm run ge:v4:h:no-refresh:batch:run
npm run ge:v4:h:no-refresh:batch:resume
npm run ge:v4:h:no-refresh:batch:status
npm run ge:v4:h:no-refresh:batch:report
```

### 12. 增长引擎只读/可编辑性核查

这些命令只检查字段是否可编辑，不修改文字、级别，不点击“保存并同步”。

#### 3.0 历史只读问题回归

入口：`src/growth-engine-h-v3-readonly-recheck.mjs`

```bash
npm run ge:v3:h:readonly-recheck:plan
npm run ge:v3:h:readonly-recheck:auth
npm run ge:v3:h:readonly-recheck:run
npm run ge:v3:h:readonly-recheck:resume
npm run ge:v3:h:readonly-recheck:status
npm run ge:v3:h:readonly-recheck:report
```

#### 3.0 当前/补充归属核查

入口：`src/growth-engine-h-v3-current-audit.mjs`、`src/growth-engine-h-v3-supplement-audit.mjs`

功能：按区块 ID、弹窗上下文、预览 DOM 归属 H 设置项；区分只读、无法归属、页面异常和映射冲突。

```bash
npm run ge:v3:h:current-audit:run
npm run ge:v3:h:current-audit:resume
npm run ge:v3:h:current-audit:status
npm run ge:v3:h:current-audit:report

npm run ge:v3:h:supplement:run
npm run ge:v3:h:supplement:resume
npm run ge:v3:h:supplement:status
npm run ge:v3:h:supplement:report
```

#### 4.0 全部富文本区块可编辑性核查

入口：`src/growth-engine-h-v4-editability-audit.mjs`、`src/growth-engine-h-v4-current-audit.mjs`、`src/growth-engine-h-v4-supplement-audit.mjs`

功能：覆盖 4.0 页面中的支持富文本区块；刷新增长引擎扫描；读取全部 H 设置项；检查文字/级别是否明确只读；按区块归属并输出问题、无法归属、不支持富文本和页面异常清单。

```bash
npm run ge:v4:h:audit:plan
npm run ge:v4:h:audit:auth
npm run ge:v4:h:audit:run
npm run ge:v4:h:audit:resume
npm run ge:v4:h:audit:status
npm run ge:v4:h:audit:report

npm run ge:v4:h:current-audit:run
npm run ge:v4:h:current-audit:resume
npm run ge:v4:h:current-audit:status
npm run ge:v4:h:current-audit:report

npm run ge:v4:h:supplement:plan
npm run ge:v4:h:supplement:run
npm run ge:v4:h:supplement:resume
npm run ge:v4:h:supplement:status
npm run ge:v4:h:supplement:report
```

## 四、增长引擎试跑专用预览地址能力

入口：`src/preview-url-resolver.mjs`

功能：正式域名自动转换为预览域名，并保留来源字段；例如：

```text
site.example.invalid
→ site.example.invalid
```

支持：缓存破除、HTTP/404 检查、预览地址来源记录、自动拼接失败时从编辑器读取真实预览地址回退。它不是独立业务命令，而是由增长引擎 H 脚本调用。

## 五、辅助脚本和报告脚本

这些脚本不是主要浏览器流程，主要用于整理输入、迁移状态、重建报告或检查模板：

| 文件 | 作用 |
|---|---|
| `scripts/build_v3_growth_engine_batch_source.mjs` | 从已有 3.0 状态生成增长引擎批量任务源 |
| `scripts/build-ge-final-issues-data.mjs` | 整理增长引擎最终问题数据 |
| `scripts/recheck-preview-pages.mjs` | 批量重新检查预览页面 |
| `scripts/requeue_online_heading_failures.mjs` | 将“上线”批次失败项重新排队 |
| `scripts/write_online_retry_report.mjs` | 生成上线批次重试报告 |
| `scripts/reset_v3_from_status_xlsx.py` | 根据状态 Excel 重置 3.0 任务状态 |
| `.work-report/build_h_issue_report.mjs` | 生成 H 标签问题报告 |
| `.work-report/build_readonly_report.mjs` | 按只读口径生成问题/不计 Bug 报告 |
| `.work-report/build_v4_readonly_template_report.mjs` | 生成 4.0 只读报告模板 |
| `.work-report/inspect_template.mjs` | 检查模板/工作簿内容 |

## 六、当前已有的主要状态和结果目录

状态文件在 `.state/`，报告在 `reports/`，失败证据和 Trace 在 `artifacts/`。

重点状态：

- `.state/run-state.json`：最早的普通 3.0 区块铺页。
- `.state/component-run-state.json`：3.0 组件铺页和组件标题配置。
- `.state/ranking-heading-run-state.json`：区块排名任务。
- `.state/v3-full-heading-state.json`：3.0 全量区块/H2。
- `.state/v3-online-heading-state.json`：上线区块任务。
- `.state/v4-block-run-state-proxy.json`：4.0 代理环境区块铺页。
- `.state/v4-rich-text-setup-state.json`：4.0 富文本准备结果。
- `.state/growth-engine-h-v3-preview-pilot-state.json`：当前 3.0 `/001.html` 预览地址试跑。

## 七、别人换电脑后的推荐使用方式

1. 复制项目代码、`package.json`、`config/` 和需要的输入文件。
2. 在新电脑执行 `npm install`。
3. 不复制 `.auth/`，在对应任务重新执行 `auth` 登录。
4. 先执行对应的 `plan`，确认输入数量和目标站点。
5. 用 `run:poc` 先试跑一页；确认报告后再用全量 `run`。
6. 中断使用 `resume`，查看结果使用 `status`，重新生成报告使用 `report`。
7. 只有明确需要改变网站时才使用带 `--apply` 的写入命令；只读核查命令不要添加 `--apply`。
