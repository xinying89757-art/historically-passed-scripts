# 领动编辑器区块铺设自动化

这个项目按 CSV 原顺序，将自定义页面可用的区块按每页 6 个铺到领动编辑器中，并持续输出可恢复状态、区块—页面映射、失败清单、截图和 Playwright Trace。

默认配置对应当前测试站：

- 编辑器入口：`https://website.leadong.com/phoenix/pagebuilder/layout`
- 公网域名：`http://site.example.invalid`
- 页面名：`GE-区块测试-001`、`GE-区块测试-002`……
- 页面路径：`/ge-block-test-001`、`/ge-block-test-002`……
- 新建页类型：网页编辑器 3.0 → 添加空白页

## 安全设计

- `plan`、`probe` 不修改网站。
- 真正创建页面必须显式传 `--apply`。
- 发布与铺页分成两个命令；发布还必须传入测试站域名进行二次确认。
- 默认只使用一个浏览器写入 Worker。
- 每页保存后才将暂存区块提交为 `added`；中断恢复时先打开当前页并按 DOM 区块 ID 对账。
- CSV 名称中包含“产品详情”的区块直接记录为 `deferred_detail`；其他区块在自定义页面搜索不到时也记录为 `deferred_detail`，均不占页面槽位。
- 仅按 `block_id` 搜索，并在填值后按 Enter 触发查询；首次无结果即记录并跳过，不二次搜索，`APP_NAME` 不用于编辑器定位。
- 每个区块搜索前都悬浮并点击内容区加号，等待侧栏左边界完全进入屏幕且搜索框可编辑；不会复用折叠在屏幕外的搜索 DOM。
- 搜索结果卡片会先悬浮，等待“添加”按钮出现后再点击；隐藏按钮不会被误判为缺失。
- 输入 ID 并回车后会轮询精确结果卡片最长 10 秒；仅明确无数据或等待结束仍无卡片时才记录跳过。
- 页面名称和 URL 填写后点击弹窗底部“确定”；创建接口遇到明确的 5xx 会自动重试一次。
- 每满 6 个成功区块，点击编辑器右上角“保存”（`#saveLayout`），保存接口返回 2xx 后才提交进度。
- 已添加但无法安全移除的异常区块会让任务停止，避免保存出错误映射。
- 单个或连续多个区块未插入/未渲染时分别记录并继续补位；登录失效、编辑器核心 UI 不可用或页面连续保存失败时停止并保留现场。
- 区块渲染总等待上限为 60 秒；若 5 秒内完全没有目标 DOM 或加载信号，则提前判定“点击未生效”，避免无效长等待。

## 第一次运行

本目录会向上复用工作区内已有的 Playwright 1.61.1。若迁移到其他机器，再执行 `npm install`。

```bash
cd ${ARCHIVE_WORKSPACE}/block-page-automation

# 1. 只读取 CSV，检查数量与预计页数
npm run plan

# 2. 打开独立 Chrome 配置，手动登录一次
npm run auth

# 3. 只读探测编辑器 DOM；不创建页面
npm run probe
```

`probe` 会把页面、iframe、候选按钮和输入框信息写入 `artifacts/probe-*.json`，用于校准 `config/local.json` 中的选择器。新建页面已按实际界面实现为“3.0 编辑器 → 添加空白页 → 选取 → 页面名称/页面 URL → 底部确定”；保存以右上角保存按钮对应接口的 2xx 响应为主要成功凭证，提示文案为兼容回退。

## 小流量 POC

先只创建 1 页，不发布：

```bash
npm run run:poc
```

也可以限制最多成功添加的区块数：

```bash
node src/cli.mjs run --apply --max-blocks 6
```

POC 人工确认页面名称、路径、6 个区块和顺序后，再执行全量：

```bash
npm run run
```

若进程中断，原命令重跑即可。状态在 `.state/run-state.json`，输入 CSV 校验值不一致时脚本会拒绝误恢复。

## 发布

铺页完成后，发布命令会先逐页打开编辑器并核对区块 ID；只有全部一致才点击全站发布。必须显式确认站点：

```bash
node src/cli.mjs publish \
  --apply \
  --confirm-site site.example.invalid
```

发布完成后脚本逐页访问公网 URL，验证页面可访问且 DOM 中存在映射的区块 ID，并把通过项更新为 `published_verified`。

## 输出

- `reports/block-page-mapping.csv`
- `reports/deferred-blocks.csv`
- `reports/failed-blocks.csv`
- `reports/report.html`
- `artifacts/screenshots/*.png`
- `artifacts/traces/*.zip`

## 本地选择器覆盖

新建 `config/local.json`，只写需要覆盖的字段，例如：

```json
{
  "selectors": {
    "pageNamePlaceholders": ["实际页面名称占位文案"],
    "pagePathPlaceholders": ["实际页面地址占位文案"]
  }
}
```

运行时使用：

```bash
node src/cli.mjs probe --config config/local.json
```

配置采用深度合并，未覆盖项继续使用 `config/default.json`。

## 增长引擎 H 标签同步自动化

这一套命令用于在增长引擎中修改指定页面的全部可编辑 H 标签，并在同步完成后，从“页面详情”中真实点击预览地址，对预览 DOM 的标签级别和文字进行逐项断言。

当前试跑配置在 `config/growth-engine-h.json`：

- 登录入口：`https://admin.example.invalid/website.html`
- 目标页面：`/001.html`
- 3.0 编辑器回填核对页：`组件标题测试-001`
- 代理：`http://proxy.example.invalid:8080`
- 预览地址不依赖配置中写死的域名，运行时会从页面详情中的“预览地址”链接重新读取并点击。

### 第一次使用或登录过期

```bash
npm install
npm run ge:h:auth
```

浏览器打开后人工登录，确认进入“我的网站”再关闭窗口。登录状态只保存在本机 `.auth/growth-engine-h`，不要把这个目录复制给其他人；换电脑后重新执行 `ge:h:auth`。

### 安全的只读检查

```bash
npm run ge:h:plan
```

该命令不会修改 H 标签。它会进入目标页面、动态读取“编辑标签”弹窗中的实际设置组数，并点击预览链接核对当前基线。

设置组数不固定为 6：弹窗实际加载出几组就处理几组。只有“级别控件数量”和“文字控件数量”不一致，或增长引擎与预览页 H 数量不一致时，才会以 `locator_ambiguous` 停止写入。

### 开始一个新批次

```bash
npm run ge:h:run:poc
```

该命令会真实修改外部数据，脚本内部必须收到 `--apply` 才允许执行。流程为：

1. 等待“编辑标签”弹窗及全部设置组加载稳定。
2. 修改每一组中所有可编辑的级别和文字。
3. 点击“保存并同步”，等待确认框、同步结果和界面恢复。
4. 从增长引擎顶部切换到配置中的目标站点，点击“网页编辑”，打开 3.0 编辑器中的 `组件标题测试-001`。
5. 逐项定位包含预期标题文字的组件，打开真实设置弹窗，核对标题文字和 H 级别后点击取消；这一步不保存、不改动编辑器。
6. 返回增长引擎点击“刷新”，等待按钮 loading、禁用状态和加载遮罩全部结束。
7. 从页面详情重新读取并点击“预览地址”。
8. 对预览 DOM 的 H 数量、顺序、级别和文字逐项断言。

如果增长引擎和预览已经完成，只想重新核对 3.0 编辑器回填，不要重新开始一个写入批次，可运行：

```bash
npm run ge:h:editor-check
```

该命令是只读操作。它会进入增长引擎以复用同一站点切换入口，再打开 `组件标题测试-001`，逐一读取组件设置弹窗；单个组件不匹配时截图、记录并继续检查其余组件。

文字修改会保留当前组件或区块的来源文字，并在末尾追加唯一同步批次，例如：
`组件标题测试-002-图片集｜同步验证批次20260819123456第03项`。如果上一批次曾使用旧的纯测试文字，脚本会从历史状态恢复首次修改前的组件或区块文字；重复执行也不会叠加多个同步后缀。标题级别使用 H1→H2→…→H6→H1 的固定轮转，以便自动化能够准确断言。

注意：再次执行 `ge:h:run:poc` 会开始新的测试批次并生成新测试文字。若只是继续中断任务或重新验证当前批次，应使用恢复命令。

### 中断恢复或重新验证当前批次

```bash
npm run ge:h:resume
```

恢复时会读取 `.state/growth-engine-h-run-state.json`。如果界面当前值已经等于状态中的预期值，脚本不会重复修改，只执行刷新和预览验证。

### 查看状态与重新生成报告

```bash
npm run ge:h:status
npm run ge:h:report
```

输出位置：

- `.state/growth-engine-h-run-state.json`
- `reports/growth-engine-h/growth-engine-h-results.csv`
- `reports/growth-engine-h/growth-engine-h-editor-backfill.csv`
- `reports/growth-engine-h/growth-engine-h-non-editable.csv`
- `reports/growth-engine-h/growth-engine-h-failures.csv`
- `reports/growth-engine-h/growth-engine-h-report.html`
- `artifacts/growth-engine-h/growth-engine-h-trace.zip`

核心实现文件：

- `src/growth-engine-h-cli.mjs`
- `src/growth-engine-h-editor.mjs`
- `src/growth-engine-h-editor-backfill.mjs`
- `src/growth-engine-h-state.mjs`
- `src/growth-engine-h-report.mjs`
- `test/growth-engine-h.test.mjs`

### 批量执行本次新增的3.0组件页和区块页

批量流程严格按以下顺序逐页执行：

```text
读取页面清单
→ 增长引擎定位页面
→ 修改全部可编辑H标签
→ 保存并同步
→ 增长引擎刷新
→ 打开预览地址并断言级别和文字
→ 进入3.0编辑器检查真实设置回填
→ 记录结果
```

任务清单直接读取现有铺页状态，不需要再次手工录入：

- 组件页：`.state/component-run-state.json`
- 区块页：`.state/ranking-heading-run-state.json`

脚本会先扫描增长引擎的全部页面路径。组件页优先使用状态中记录的页面路径；如果实际页面使用 `/001.html`、`/002.html` 这类三位数字路径，则自动使用增长引擎中真实存在的路径，不根据名称猜测。

常用命令：

```bash
# 只读列出所有页面及匹配到的增长引擎路径
npm run ge:h:batch:plan

# 可见浏览器试跑前两个组件页面
npm run ge:h:batch:run:poc

# 中断后继续，不重复修改已经应用的值
npm run ge:h:batch:resume

# 查看当前批次状态
npm run ge:h:batch:status

# 全量执行；也可追加 -- --scope components 或 -- --scope blocks
npm run ge:h:batch:run
```

编辑器回填根据原铺页方式检查：普通组件读取设置弹窗；“文本”组件点击画布文字元素、选中文字并从富文本“格式”读取当前标题级别；后续自定义代码和多富文本组件继续使用各自原设置入口。检查只读取并取消关闭，不保存编辑器。

批量状态和报告：

- `.state/growth-engine-h-batch-run-state.json`
- `.state/growth-engine-h-batch-pages/<批次号>/<页面任务>.json`
- `reports/growth-engine-h-batch/<批次号>/growth-engine-h-batch-report.html`
- `reports/growth-engine-h-batch/<批次号>/growth-engine-h-batch-pages.csv`
- `reports/growth-engine-h-batch/<批次号>/growth-engine-h-batch-results.csv`
- `artifacts/growth-engine-h-batch/<批次号>/<页面任务>/growth-engine-h-trace.zip`

2026-08-19首轮批量试跑使用“组件标题测试-001”和“组件标题测试-002”，共12个H标签；两页的增长引擎保存同步、预览DOM和3.0编辑器回填均验证通过。

## 4.0 编辑器全量区块铺设（代理测试环境）

当前 `config/v4-blocks.json` 专用于代理测试环境：

- 入口：`https://admin.example.invalid/website.html`
- 代理：`http://proxy.example.invalid:8080`
- 分类：图片集、图文
- 范围：两个分类的全部 215 个唯一候选（图片集 157、图文 58），包含名称或描述带“定制”的区块
- 每页：最多 10 个，最后一页允许不足 10 个
- 登录、状态、报告均与未挂代理的正式环境任务隔离

```bash
# 首次或登录失效时登录代理环境
npm run v4-block-auth

# 只读查看全量候选、分类数量、代理和预计页数
npm run v4-block-plan

# 只读探测能否从“我的网站”进入4.0编辑器
npm run v4-block-probe

# 全量执行；中断后可使用 resume
npm run v4-block-run
npm run v4-block-resume

# 查看当前状态
npm run v4-block-status

# 仅重试明确失败的区块
npm run v4-block-retry -- --block-ids 45364,39634
```

代理环境独立产物：

- `.state/v4-block-run-state-proxy.json`
- `reports/v4-blocks-proxy/v4-block-page-mapping.csv`
- `reports/v4-blocks-proxy/v4-block-failures.csv`
- `reports/v4-blocks-proxy/v4-block-report.html`
- `artifacts/v4-blocks-proxy/traces/*.zip`

自动化会优先用本次点击产生的唯一画布节点确认区块，避免其它区块配置中引用相同 `block_id` 时误判重复。失败区块重试前会校验当前状态，已经添加成功的区块禁止重复添加。
