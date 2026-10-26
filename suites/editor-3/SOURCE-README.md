# 领动 3.0 编辑器：区块添加与 H 标签设置自动化

## 产品描述文本样式验证

`src/product-description-text-settings.mjs` 使用有界面 Playwright 验证产品描述里的“内容编辑器（新版）”：输入唯一测试文案，依次设置粗体、斜体、下划线、删除线、居中、字号、行距、文字颜色和背景色；检查后台渲染结果后保存产品，再打开产品详情页、选择本次新增的描述标签，检查前台实际显示的文字与样式。保存时如果出现重复 Title 确认框，脚本会确认后继续验证。

在本目录运行：

```bash
npm run product:description-text-settings
```

默认使用有界面 Chromium。可通过环境变量覆盖站点、产品和登录配置；账号配置文件只从磁盘读取，不会写入脚本或结果：

```bash
BUG1004949_ADMIN_CONFIG="/绝对路径/admin-login.json" \
UI_ADMIN_LOGIN_URL="https://admin.example.invalid/login.html" \
UI_ADMIN_URL="https://admin.example.invalid/website.html" \
UI_BASE_URL="http://site.example.invalid" \
UI_PROXY="http://proxy.example.invalid:8080" \
PRODUCT_NAME="product one" \
npm run product:description-text-settings
```

设置 `UI_PROXY=none` 可禁用代理；加 `-- --headless` 可在无界面模式运行。脚本会保存产品并保留验证用的描述分组，方便从前台复查。每次运行的 `result.json`、后台/前台截图保存在 `outputs/product-description-text-settings/<运行编号>/`。脚本使用编辑器现有 title、iframe、可编辑区和产品表单字段定位；当前验证流程不需要 Midscene。

这个压缩包用于复用本次已经跑通的两段流程：

1. 根据 Excel 中的区块 ID，新建 3.0 空白自定义页面，每页添加 6 个区块并点击右上角“保存”。
2. 按区块模板进入可编辑文字区域，把文字替换为唯一中文测试文字，通过“格式 → 标题 2”设置为 H2，再保存页面并核对回填。
3. AI 区块模式在独立页面按顺序生成 5 种首批类型，并可继续生成 002/003 两个页面的 8 种非详情类型，检查编辑器、预览和发布后的公开页。

脚本使用有界面的 Chrome，执行时可以直接看到每一步操作。普通区块命令不会自动发布网站；AI 区块命令会按配置执行发布并等待公开页生效。
脚本会自动复用登录态；登录失效时按管理员登录流程自动重新登录。

## 一、压缩包里有什么

- `inputs/区块排名.xlsx`：本次区块清单，已经内置。
- `config/run.json`：接收人只需要重点修改这个配置。
- `src/`：3.0 区块添加、H 标签设置、保存、恢复和报告脚本。
- `test/`：清单解析与状态安全检查。
- `.auth/`、`.state/`、`artifacts/`、`reports/`：首次运行后在接收人的电脑本地生成，压缩包中不包含。

清单会自动排除“产品详情”和“图片集类型4”；同一 ID 出现在多个模板类型时只添加一次，但会保留全部模板信息。

AI 首个页面覆盖静态图文、产品列表、文章列表、视频列表和图册列表；后续页面覆盖下载列表、FAQ 列表、产品分类、文章分类、视频分类、图册分类、下载分类和 FAQ 分类。详情回归单独进入系统页：当前覆盖文章详情、图册详情、视频详情各 1 个区块；由于系统页 AI 类型菜单当前没有“产品详情”，产品详情明确记录为未覆盖。产品筛选和导航使用独立专项，不混入 001–003 页面。每个新类型生成前会先使用 AI 弹窗“一键润色”提示词；润色失败会写入状态并使用原始提示词继续生成，生成/应用/预览/发布仍分别校验。每次应用后默认等待 5 秒，发布后先等待 15 秒，再以 3 秒间隔轮询公开页。

## 二、运行前准备

接收人的电脑需要：

- Node.js 20 或更高版本；建议安装 Node.js LTS。
- Google Chrome。
- 能访问领动测试环境的网络和一个有目标站点编辑权限的账号。
- 目标站点只允许一个人/一个脚本同时写入，不要并行执行。

在终端进入解压后的目录，先检查版本：

```bash
node --version
npm --version
```

安装依赖：

```bash
npm install
```

## 三、配置目标站点

打开 `config/run.json`：

```json
{
  "siteName": "YOUR_TEST_SITE",
  "siteLanguage": "英语",
  "publicBaseUrl": "http://site.example.invalid"
}
```

- `siteName`：在“我的网站”中显示的站点名。
- `siteLanguage`：需要编辑的语言名称，必须和页面文字一致。
- `publicBaseUrl`：该语言的前台域名，用于发布后的公开页验证；普通区块流程不发布，AI 专项会发布。

默认登录配置复用外部文件 `../../outputs/BUG1004949-admin-login-20260916/config/admin-login.json`，账号密码不会写入本项目源码。也可以使用环境变量覆盖：

```bash
export BUG1004949_ADMIN_CONFIG="/绝对路径/admin-login.json"
export BUG1004949_ADMIN_ACCOUNT="你的账号"
export BUG1004949_ADMIN_PASSWORD="你的密码"
export UI_PROXY="http://proxy.example:8080"   # 仅在确实需要代理时设置
```

默认不使用代理，管理员入口为 `https://www.leadong.com/website.html`。只有显式设置 `UI_PROXY` 时才会启用代理；也可以使用 `UI_PROXY=none` 强制直连。

如果在一个已经存在“区块排名H测试-001”等页面的站点重新跑，请在 `config/run.json` 中额外覆盖下面两个值，避免重名：

```json
{
  "pageNamePrefix": "区块排名H测试-同事甲-",
  "pagePathPrefix": "block-ranking-heading-colleague-a-"
}
```

页面名称可以用中文，`pagePathPrefix` 只使用小写英文字母、数字和连字符。

## 四、推荐执行顺序

### 1. 先检查清单

```bash
npm run plan
```

预期会看到：65 个唯一目标区块、20 行被排除、预计 11 页，以及前 8 个模板代表区块。

### 2. 登录

推荐使用自动登录：

```bash
npm run login
```

命令会自动完成管理员登录、返回领动云平台，并校验进入 `YOUR_TEST_SITE` 的英语站点。登录态保存在 `.auth/chrome-profile`，同时保存一份权限为 600 的 `.auth/admin.storage.json`。

如果需要人工处理验证码或特殊登录页，仍可使用：

```bash
npm run auth
```

脚本会打开一个独立 Chrome。人工完成登录，确认能进入目标站点的 3.0 编辑器，然后回终端按 Enter。登录状态只保存在当前电脑的 `.auth/`，不会上传或写入报告。

### 3. 先试跑一页区块

```bash
npm run add:poc
```

脚本会创建 1 个 3.0 空白页面，按 ID 添加 6 个成功区块，点击右上角“保存”后暂停。人工确认页面、区块顺序和保存结果无误后再继续。

### 4. 添加剩余区块

```bash
npm run add
```

中断、浏览器关闭或登录失效后，重新登录并执行：

```bash
npm run resume
```

脚本会读取 `.state/ranking-heading-run-state.json`，已添加成功的区块不会重复添加。

### 5. 先试跑 8 种模板的 H2 设置

```bash
npm run heading:poc
```

8 个代表模板是：文本编辑、多媒体集类型1/2、图片编辑、图片集类型1/2/3、图文页签。脚本会填写中文测试文字，选中文字，通过“格式 → 标题 2”设置 H2，并保存页面。

确认这 8 类在当前站点表现正常后，批量处理剩余已添加区块：

```bash
npm run heading
```

只处理指定 ID 时：

```bash
npm run heading:ids -- --block-ids 10744,14674
```

脚本的规则是“发现几个支持 H 标签的富文本输入区，就全部设置”；页面确实没有 H 控件时会记录为不支持并跳过，不会随机点击。

### 6. 查看结果

```bash
npm run status
npm run heading:report
```

主要结果位于：

- `reports/ranking-heading/report.html`：区块添加结果。
- `reports/ranking-heading/heading-report.html`：H2 设置汇总。
- `reports/ranking-heading/heading-results.csv`：每个区块、页面、标题文字和状态。
- `reports/ranking-heading/heading-exceptions.csv`：不支持或失败项。
- `artifacts/ranking-heading/`：失败截图、运行 JSON 和 Playwright Trace。

### 7. AI 区块按类型分页

先验证首个“静态图文”类型：

```bash
npm run ai:poc
```

确认生成、应用模块、编辑器展示和预览链路后，再运行首个页面的五种类型：

```bash
npm run ai:add
```

命令会新建 `AI区块类型回归-001`，严格使用英语提示词和“文字描述/快速模式”，按类型去重，保存后进入预览并发布；发布是异步的，脚本会等待并轮询 `publicUrl`。中断后使用：

```bash
npm run ai:resume
npm run ai:status
```

AI 状态文件为 `.state/ai-block-type-run-state.json`，记录每种类型的提示词、生成/应用/编辑器/预览/发布状态和失败原因。恢复时已应用类型不会重复插入；如果页面与状态不一致会停止，要求人工检查。

继续生成后续页面：

```bash
npm run ai:remaining
npm run ai:remaining:resume
npm run ai:remaining:status
```

后续页面分别使用 `.state/ai-remaining/page-002.json` 和 `.state/ai-remaining/page-003.json` 保存状态。页面 002、003 均有 5 个区块；页面 003 的最后两类是产品筛选和导航，并复用各自的专用设置处理器。恢复时已完成页面不会重复发布。

每种类型的状态还会记录 `original_prompt`、`polished_prompt`、`polish_status` 和润色失败原因。AI 弹窗每次关闭并重新打开后重新获得润色额度，因此每种类型都会在独立弹窗窗口内执行一次润色。

### 文章列表设置结果级回归

使用有界面 Playwright 验证文章列表侧边栏设置对实际文章数据和渲染结果的影响。每次运行创建独立测试页，默认保留页面、区块及运行状态；恢复时不会重复插入已应用的区块。

```bash
npm run ai:article-list-settings
npm run ai:article-list-settings:resume -- --run-id=<运行编号>
npm run ai:article-list-settings:status -- --run-id=<运行编号>
```

专项先从内容管理后台读取文章 ID、分类和发布时间作为对照，再验证分类筛选结果、发布日期排序、分页与每页数量、展示字段显隐和实际渲染配色。选择分类或恢复“全部文章”后，脚本会等待画布文章 ID/标题集合与后台预期一致且连续稳定，再关闭选择面板并点击“应用”；不会仅凭下拉框显示的模式名称判断数据已经切换。应用后还会重新打开侧栏核对设置，并检查预览与发布后的本站页面。

示例运行状态位于 `.state/ai-lifecycle/runs/article-list-settings-20260930-poc01/ai-article-list-settings/state.json`。若分类数据或列表数量不足以支持某项断言，结果会明确标记限制，不会据此报告通过。清理测试页需要显式执行 `npm run ai:article-list-settings:cleanup -- --run-id=<运行编号> --apply`。

### 8. AI 详情区块回归

详情命令会先从“内容管理”对应模块选取一条可前台访问的本站记录，再进入“页面 → 系统页面”的对应详情页。生成完成后会保存、预览、发布，并轮询该条记录的本站详情 URL；不会使用其他站点的详情地址。

```bash
npm run ai:detail
npm run ai:detail:resume
npm run ai:detail:status
npm run ai:detail:cleanup -- --apply
```

状态位于 `.state/ai-detail/{article,gallery,video}.json`，包含内容名称、本站详情 URL、原始/润色提示词、润色状态、编辑器/预览/发布结果和失败原因。每轮成功的详情区块会保留；下一轮只会删除 `.state/ai-lifecycle/detail-ownership/` 中能够唯一匹配的上轮区块。无法确认归属时停止，不删除人工区块。`ai:detail:status` 会额外列出尚未覆盖的详情类型；当前产品详情会显示为“系统页 AI 类型菜单当前未提供，按用户选择暂不覆盖”。

### 9. 可复用回归的测试数据生命周期

建议每次正式回归先建立独立的 `runId` 并备份脚本状态：

```bash
npm run ai:prepare -- --run-id ai-regression-20260916-001
npm run ai:backup
```

随后执行 `ai:add`、`ai:remaining` 或 `ai:detail`。运行状态会带上当前 `runId` 和 `run_marker`，不同生命周期不会交叉恢复。测试失败或需要清理时：

```bash
npm run ai:restore -- --apply
# 或者：恢复状态并结束本次生命周期
npm run ai:cleanup -- --apply
npm run ai:lifecycle:status
```

生命周期文件保存在 `.state/ai-lifecycle/`，备份包含首个页面、后续页面和详情页状态目录。`restore/cleanup` 只恢复脚本状态，不会猜测删除线上页面或系统页区块；线上 UI 清理必须依据本轮 `runId` 标记人工确认后执行，避免误删已有的 001–003 页面或其他人的修改。

### 10. 静态图文三模式点数回归

本专项在一张带独立运行 ID 的页面中依次生成快速、进阶、深度模式的静态图文区块。它关闭提示词润色，在 AI 区块弹窗右上角点击“设置”，读取“可用 N 点/总计 N 点”，分别核对 6、10、20 点的扣除。每次读取后关闭设置面板，不跳转 MoliAI 独立页面。区块应用后会等待 5 秒，再检查编辑器、预览和发布页面。默认使用有界面 Chrome。

```bash
npm run ai:mode-points
npm run ai:mode-points:status
npm run ai:mode-points:resume
```

状态保存在 `.state/ai-lifecycle/runs/<runId>/ai-mode-points/state.json`，记录每次生成前后余额、实际扣点、应用和展示结果。每种模式最多等待 20 分钟，未完成时每 30 秒关闭并重新打开生成记录，不仅轮询旧弹窗 DOM。新提示词带 runId 和 mode 标记；按记录 ID 优先、完整提示词兜底唯一匹配，不取任意最新记录。超时记为 `uncertain`，保留生成前余额；`resume` 对有提交和余额证据的超时只查记录、继续核对扣点，不重新生成。已有旧版“生成结果等待超时”状态也支持这个恢复路径；应用状态不确定仍停止核查。每次新运行保留独立页面和状态。需要显式删除本轮三个区块及测试页时执行：

```bash
npm run ai:mode-points:cleanup -- --apply
```

清理会先核对运行 ID、页面名和三个区块标题，再删除并发布；删除测试数据不会返还已消耗的 MoliAI 点数。`ai:cleanup` 是旧回归的本地状态恢复命令，不会清理本专项页面。

### 11. 静态图文三种输入方式回归

本专项在一张独立测试页中，用快速模式分别验证“文字描述”“上传图片”“提供网址”三种 AI 输入方式。上传图片使用桌面的 `测试图片.png`，网址输入使用 `https://site.example.invalid/`；每次从 AI 弹窗右上角“设置”读取余额，核对 6 点扣除。每个区块应用后立即保存，并检查编辑器、预览、异步发布和本站公开页。

```bash
npm run ai:input-modes
npm run ai:input-modes:status
npm run ai:input-modes:resume
```

状态保存在 `.state/ai-lifecycle/runs/<runId>/ai-input-modes/state.json`。已扣点且生成成功但应用状态不确定时，恢复命令会优先从生成记录直接应用，不会重复生成或扣点。需要删除本轮页面和区块时执行：

```bash
npm run ai:input-modes:cleanup -- --apply
```

### 12. AI 生成整页回归

本专项从“新建页面 → AI 生成页面”进入独立测试页，使用英文文字描述和快速模式，关闭提示词润色。它会核对目标页面实际 ID、完整区块加载、保存持久化、预览和本站公开页；保存后不搜索或切换 Home。本轮不断言点数。默认使用有界面 Chrome，测试页和运行状态保留。

页面创建在当前可见“页面设置”弹窗内提交，创建回执先落盘再等待切换。生成等待与操作等待分离：普通区块每 30 秒关闭重开查询同一条本轮记录，最多等待 3 分钟；三模式点数最多等待 5 分钟，整页最多等待 20 分钟。轮询不重复提交生成；仍在生成时记为结果待确认。三模式点数专项优先使用当前结果，也允许从本轮生成记录插入，实际应用来源写入状态；扣点与展示分别判定。页面创建／切换失败按共享页面检查点恢复，不将尚未生成的五种类型分别补测。

页面／等待机制的有界面定向验收（会正常计费，默认保留数据）：

```bash
npm run ai:verify-fixes -- --apply --run-id=<新的运行ID>
npm run ai:verify-fixes -- --apply --run-id=<同一运行ID> --resume
```

该命令只验证同页下载列表＋视频分类、三模式点数、普通整页和整页记录复用，不运行其他已通过流程。每项独立保存状态并生成 HTML 报告，末尾仅精准重试失败项一次。首次或重试已完成的任务在恢复时不再次生成。

```bash
npm run ai:full-page
npm run ai:full-page:status
npm run ai:full-page:resume
```

如果上一轮页面仍保留但需要并行新建一轮测试，可显式使用 `npm run ai:full-page -- --new-run`；旧页面和状态不会被删除或覆盖。

状态位于 `.state/ai-lifecycle/runs/<runId>/ai-full-page/state.json`。脚本通过“新建页面 → AI 生成页面”进入整页编辑器，提交后只记录请求证据，不把接口返回的 `pageRecordId` 与生成记录卡片的 `item.id` 混用。由于弹窗内生成状态不会实时更新，提交后会关闭 AI 弹窗；如果记录仍为“生成中”，每 30 秒重新打开一次弹窗读取记录，最多等待 20 分钟（最多 40 次刷新），期间不会重复点击“开始生成”。明确失败会记录失败原因并由独立重试运行处理；请求已发出但状态未确认时不会盲目重试。整页专项只对功能链路做硬断言：请求和生成记录成功、页面应用、编辑器有实际内容、保存、预览、发布和公开页可访问。AI 生成的标题、版块名称、语言和提示词文案不再作为阻断条件。整页编辑器“尚未就绪”是暂态提示，不计为生成失败。需要显式清理本轮测试页时执行：

只诊断记录列表而不生成，可运行 `npm run ai:full-page:diagnose`；若要对照某条提示词是否提交成功，可显式执行 `npm run ai:full-page:prompt-probe -- --apply --no-history-before --prompt="首页"`。对照命令可能消耗正常的整页生成点数，不会应用或发布页面，证据保存在 `.state/ai-lifecycle/full-page-probes/`。

若生成记录明确显示失败且页面尚未创建，可运行 `npm run ai:full-page -- --retry-failed` 开始新的独立运行；失败记录会保留。
若请求结果未确认，先核对生成记录及测试页；确认均不存在后，可运行 `npm run ai:full-page -- --retry-unconfirmed` 开始新的独立运行。

```bash
npm run ai:full-page:cleanup -- --apply
```

### 13. AI 生成记录复用回归

本专项在同一轮运行中先生成新的唯一记录，再强制关闭并重新打开生成记录完成添加。整页记录通过“新建页面”创建独立页面；静态图文记录在独立空白页中通过“插入/应用模块 → 应用”添加。两条链路分别完成保存、预览、发布和本站公开页验证，正常产生生成点数但不校验扣点。

```bash
npm run ai:history-reuse
npm run ai:history-reuse:status
npm run ai:history-reuse:resume
npm run ai:history-reuse:cleanup -- --apply
```

状态位于 `.state/ai-lifecycle/runs/<runId>/ai-history-reuse/state.json`。整页生成中时每 30 秒关闭并重新打开一次，最多等待 20 分钟。状态必须记录 `application_source: "history"` 才算通过；历史记录匹配为 0 或多于 1 条、区块应用前后数量不是严格增加 1、应用状态不明确时都会停止。恢复命令优先使用已经生成的记录，不再次生成或扣点。清理只删除当前 runId 的两张测试页面，不删除平台生成记录。

### 14. 产品筛选 AI 区块回归

本专项命令仍可独立创建 `AI区块类型回归-004` 用于定位问题。全量分页回归则把“产品筛选”作为页面 003 的第 4 个区块；生成结果选中后，脚本会点击区块 toolbar 设置，在右侧筛选面板勾选“全选”并点击设置面板“应用”，再执行 AI 区块最终应用。

```bash
npm run ai:product-filter
npm run ai:product-filter:status
npm run ai:product-filter:resume
npm run ai:product-filter:cleanup -- --apply
```

状态位于 `.state/ai-lifecycle/runs/<runId>/ai-product-filter/state.json`。生成区块、toolbar、筛选面板、“全选”和设置应用任一步骤无法唯一确认时会停止，不继续最终应用；清理命令只删除当前 runId 对应的 `AI区块类型回归-004` 页面和唯一匹配的产品筛选区块。

### 15. 导航 AI 区块回归

本专项命令仍可独立创建 `AI区块类型回归-005` 用于定位问题。全量分页回归则把“导航”作为页面 003 的第 5 个区块。生成并应用导航后，脚本直接点击导航区块打开右侧侧边栏，再点击“编辑导航”。它等待自定义页面列表加载，排除当前测试页，选择前两张页面，确认“已选择：2个”，点击页面列表下方的“添加”并确认两项进入导航编辑区，最后点击“保存”和区块“应用”。页面保存、预览、发布后，会从公开导航读取两条实际链接并逐一点击验证，不推测页面路径。

```bash
npm run ai:navigation
npm run ai:navigation:status
npm run ai:navigation:resume
npm run ai:navigation:cleanup -- --apply
```

状态位于 `.state/ai-lifecycle/runs/<runId>/ai-navigation/state.json`。恢复运行会优先使用已成功的生成记录，不重复生成；若页面顶部尚未保存且编辑器区块已丢失，会重新插入该记录并重新配置导航。已发布页面不会重复发布；清理须显式执行。

### 16. AI 图片集区块回归

图片集类型使用独立专项和独立测试页面，不加入现有 15 种区块分页或全量回归。脚本只精确匹配 AI 类型菜单中的“图片集”，不会回退选择“图册列表”或名称相近的类型。执行完整生成、应用、保存、预览、发布及公开页检查；普通生成等待上限 3 分钟，提示词润色沿用专项配置。页面和区块默认保留，不验证点数。

```bash
npm run ai:image-gallery
npm run ai:image-gallery:resume -- --run-id=<runId>
npm run ai:image-gallery:status -- --run-id=<runId>
```

### 17. AI 复合区块回归

复合区块专项独立于全量回归，在带 `runId` 的测试页验证静态图文默认布局与最多 3 种动态区块组合。本次配置为静态图文 + 产品列表 + 产品分类，生成模式为深度模式，包含生成、应用、保存、预览、发布和公开页验证；页面和状态默认保留。平台明确返回生成失败时，脚本自动发起下一次独立生成（每次带不同 attempt 标记），最多尝试 10 次并逐次记录；生成最多等待 10 分钟，每 30 秒关闭并重新打开记录查询。等待超时或状态不明时不会盲目重生成。

```bash
npm run ai:composite
npm run ai:composite:resume -- --run-id=<runId>
npm run ai:composite:status -- --run-id=<runId>
```

状态位于 `.state/ai-lifecycle/runs/<runId>/ai-composite/state.json`。恢复会先核对站点、页面和状态；已完成运行直接返回，明确失败时按上限重生成，应用状态不确定时停止，避免重复插入。

### Products 系统页复合区块分类交互

```bash
npm run ai:composite:products
npm run ai:composite:products:resume -- --run-id=<runId>
npm run ai:composite:products:status -- --run-id=<runId>
```

生成位置固定为“页面 → 系统页面 → Products”，组合为静态图文、产品列表、产品分类，使用深度模式及现有提示词润色策略。每轮先处理上轮所有权区块，再从 Products 页提交新的生成。完成应用、保存、重新打开后，分别在预览和公开页实际点击本轮区块里的“测试分类”，验证跳转到本站该分类的 Products 页面，并在同一个稳定区块 ID 内核对产品列表，排除原有产品列表干扰。

产品预期集合从本站内容管理后台“管理产品”顶部的分类筛选读取：选择“测试分类”并查询，将筛选结果中的产品稳定 ID 作为预期集合；不再逐条展开其他产品的“更多”分类。预览和公开页都按本轮复合区块的稳定 ID 对比实际产品集合。当前测试分类对应“测试产品”，预期数量按筛选结果实时确定。

本轮成功后保留区块。下一轮开始前，先核对后台测试数据，再仅删除 `.state/ai-lifecycle/composite-products-ownership/` 中站点、语言、Products 页面 ID、区块稳定 ID 均匹配且唯一的上一轮自动化区块；先保存删除结果，待新生成成功后再统一发布。人工区块及归属不明区块不删除。删除中断时核对已持久化的删除意图与实际页面，不重复删除；应用状态不确定时停止，避免重复插入。Products 页面使用执行锁防止两个进程同时清理或生成。生成记录按任务 ID 或唯一提示词匹配，统一换行／空白字符后识别平台明确失败，避免已经失败却一直等待超时。

状态：`.state/ai-lifecycle/runs/<runId>/ai-composite-products/state.json`。报告：`reports/composite-products/<runId>/report.html`。截图：`output/playwright/composite-products/<runId>/`。此专项独立于原自定义页复合区块脚本及全量回归，默认不清理其他测试页。

### 17. AI 全量稳定回归

全量命令默认运行三页共 15 种非详情区块、文章/图册/视频详情、三模式点数、三输入方式、整页生成和生成记录复用。所有非详情页面名称和路径都追加同一个 `runId` 并默认保留；历史 004、005 页面不会被删除。

```bash
npm run ai:regression
npm run ai:regression:resume
npm run ai:regression:status
npm run ai:regression:report -- --run-id=<runId>
```

总状态位于 `.state/ai-lifecycle/runs/<runId>/suite/state.json`。每轮会自动生成 `reports/ai-regression/<runId>/report.html`，并更新 `reports/ai-regression/latest.html`。报告以中文业务链路展示累计执行耗时、阶段和具体测试点结果，使用绿色、红色、橙色、蓝色和灰色区分通过、失败、阻断、运行中和未执行。已部分完成的测试点显示“未完成”；前置失败后的默认 false 不误判为失败。页面通过“查看测试页面”按钮访问，点数用预期/实际扣除点数说明。来源路径、原始参数、提示词及调用日志只保留在原始状态文件中。

全量回归默认采用“先执行所有独立阶段，最后仅重试失败测试项一次”。五区块页面按“页号＋类型”定位失败项：例如页面 002 已通过、页面 003 导航失败时，不重新生成其他九个区块。三模式按模式、三输入方式按输入方式、详情按类型、记录复用按整页／区块分支独立重试。整页生成仍是一个不可拆分的测试项。普通业务失败不阻止后续独立测试；应用结果不确定时隔离当前页面，不继续插入，但继续其他页面和阶段。登录失效、站点/语言不符或余额不足仍会停止。`regressionSuite.retryFailedAtEnd` 可关闭末尾重试，每个测试项的末尾重试上限为 1。

精准重试优先从失败检查点恢复：导航配置、筛选全选、保存、预览和发布不自动重新生成。无法修复的非详情失败项使用独立的 `-r1-<目标摘要>` 运行标记，在只包含该项的新测试页补跑（允许再次扣点），不删除或覆盖原页。重试页按实际区块数断言，允许少于五个。详情仅恢复失败类型，沿用原系统页和所有权保护，归属或应用不明确时拒绝新增。

`suite/state.json` 的 `retry_items` 保存首次结果、失败步骤、最终结果、逐项 `retry_count` 及累计重试耗时；具体任务位于 `suite/item-retries/<重试运行ID>/task.json`，执行前先保存任务和预算。跨进程恢复复用同一任务；已完成或耗尽预算的项不会再次生成。旧阶段级重试已经耗尽的预算不会因升级重置。无法从明确关联的状态文件唯一定位目标时显示“结果未确认”，不回退到整阶段重跑。整页的内部立即重试在总回归中关闭。

报告按最终测试项结果汇总，补测成功显示绿色“重试通过”；首次失败、独立补测页、各次扣点和截图分别保留，同一测试项只计数一次。原页状态文件保持原样；另页通过不代表原页的五区块完整链路已经修复。仅报告目标，不自动删除测试数据。

分页区块应用只计数 3.0 正文：排除 AI 结果 iframe 及嵌套画布、合并嵌套包装器，要求原区块 ID 保持且唯一新增 ID 稳定后才标记应用成功。每个成功区块保存一次编辑器检查点；后续类型失败不会丢失前面已经确认的内容。旧状态没有稳定区块 ID 时不按数量猜测类型，保留旧页并转入隔离重试。失败截图按 runId 和页面/类型保存，报告读取最终尝试的实际子状态，不显示原始参数。

`npm run test:ai-commit-ui` 使用有界面 Chrome 和内存测试页面检查包装器去重、占位/隐藏模板排除、未保留 AI 类名的已提交模板、唯一新增区块确认、预览懒加载兼容以及关闭按钮分层定位；不登录平台、不消耗 AI 点数。生成与结果编辑界面分别关闭，退出确认在所有 frame 中查找，遮罩未消失时不点击下一入口。齿轮限定在本次 AI 结果 frame 内，不对被遮罩挡住的后台工具栏执行 force 点击。

失败截图直接内嵌在单文件 HTML 中（不限制 5MB），点击缩略图可在报告内放大，用“关闭”或 Esc 退出；缺失或损坏截图显示“截图不可用”。复制报告、打开 `latest.html` 均无需访问原始图片文件。整页优先使用最终 CLI 返回的状态；旧运行仅按明确记录的重试 runId 与所属运行关联读取，不使用全局最新指针，关联不明确显示“结果未确认”。`npm run ai:regression:report -- --run-id=<runId>` 仅离线重建报告，不执行平台流程；`npm run test:ai-report-ui -- --run-id=<runId>` 使用有界面 Chrome 离线检查报告与截图交互。

已经通过的阶段恢复时会跳过；普通业务失败会记录后继续独立阶段。应用状态不确定仅隔离当前页面，登录、站点/语言不匹配或余额不足会阻断全局后续生成。

三模式专项如果生成记录明确显示失败并自动退款，会再次通过设置面板核对余额已经恢复到生成前数值；确认后保留该模式失败，继续下一模式并验证已成功模式的预览、发布和公开页。未确认退款、扣点或应用状态时不继续该专项。该处理不会把退款后的失败生成误标为扣点通过，也不会自动重新生成失败模式。

平台明确提示站点页面数量已达上限时，记录 `PAGE_CAPACITY_LIMIT`，不再误报“添加空白页”定位超时，也不自动删除旧页。需要人工释放页面名额或提高上限后再开启新一轮。产品筛选优先点击实际 `.block_productFilter` 组件，等待组件加载而不是点击空布局包装器；全选勾选结果与公开页实际筛选控件分别校验，占位提示不能作为展示通过。

详情区块会在本轮完成后保留。下一轮开始时，脚本只会删除所有权文件能够唯一匹配的上一轮详情区块，然后保存编辑器但不单独发布，最后用本轮新详情区块统一发布替换。无法确认归属、匹配为零但存在其他 AI 区块、或匹配多个区块时均停止。所有权位于 `.state/ai-lifecycle/detail-ownership/`。人工确认后需要显式清理当前自动化详情区块时执行：

```bash
npm run ai:detail:cleanup -- --apply
```

#### 加载完成、失败隔离和超时恢复

整页直接添加与生成记录复用共用同一个添加完成屏障：读取成功生成记录的区块总数，等待当前测试页的实际正文区块数量完全一致、各区块有内容、图片及加载遮罩完成，并保持稳定 3 秒。添加最多等待 5 分钟，期间不刷新、不重新选页、不保存；超时记录进度、截图和不确定应用状态并安全停止。保存之后才检查自定义页面列表；预览和公开页也检查实际正文区块，不把预览工具栏当作生成内容。区块总数不可读取时拒绝猜测。

分页回归把已确认应用后的普通区块展示异常保留为失败，并继续下一类型；前一类型失败不会跳过筛选、导航，也不会因页面 002 的业务失败跳过页面 003。每种类型按本次应用前后的区块数量增量校验，避免缺失一个区块导致后续类型连续误报。应用没有确认、登录失效等安全异常仍停止；恢复不会按有问题的计数器盲目重插已应用区块。

验证维护代码（不登录平台、不消耗点数）：

```bash
npm test
npm run test:ai-stability-ui
```

第二条命令打开有界面 Chrome，使用本地时序夹具验证分批插入、占位内容延迟完成、辅助 iframe 不产生隐式长等待，以及预览工具栏不被当作正文；截图保存在 `output/playwright/`。

### 17. 产品列表设置的 Midscene 视觉兜底

产品列表设置专项仍以 Playwright 为主，只有 DOM 点击或状态确认失败时才使用 Midscene.js 视觉定位。当前覆盖产品数据、产品排序、加载方式、每页显示数量、展示内容和基础配色六项设置；每项最多调用一次视觉模型，最终值仍由 Playwright 校验。

使用 DeepSeek 视觉模型前，在终端设置外部环境变量：

```bash
export MIDSCENE_MODEL_BASE_URL="https://api.deepseek.com"
export MIDSCENE_MODEL_API_KEY="你的 DeepSeek API Key"
export MIDSCENE_MODEL_NAME="deepseek-flash"
export MIDSCENE_MODEL_FAMILY="deepseek"
```

然后执行：

```bash
npm run ai:product-list-settings:resume -- --apply --run-id=<runId>
```

如果 Playwright 已经成功定位，Midscene 不会被调用；如果视觉定位超时或未返回有效坐标，脚本会保留截图和设置项失败原因，不会继续误操作。状态中的 `locator_source`、`fallback_used` 和 `midscene_duration_ms` 可用于评估每次运行的定位稳定性。

区块选择先唯一确认 `/phoenix/pagebuilder` 画布和产品列表标记；只有当前版本提供与该区块绑定的全屏编辑入口时才进入全屏编辑器，并在 frame 导航后重新解析画布和侧栏。找不到唯一目标或侧栏标签不完整时会停止，不使用全局齿轮或固定坐标。保存后会重载 3.0 编辑器再验证预览；预览内容 frame 通过本站预览域名和测试页路径唯一匹配，每次轮询重新解析，避免拿到导航前失效的 frame。若预览按钮创建的 popup 被平台立即关闭，脚本仅使用按钮中已校验的预览 href 在同一浏览器上下文打开页面，结果仍须通过产品卡片、分页、字段和计算样式断言。

需要重复验证设置项时，可从已有成功生成记录播种独立测试运行，不会再次请求 AI 生成或扣点：

```bash
npm run ai:product-list-settings -- --run-id=<newRunId> --history-run-id=<successfulSourceRunId> --apply
```

常规六项回归仍按现有配置跳过产品分类；分类可单独执行：

```bash
npm run ai:product-list-settings -- --run-id=<newRunId> --history-run-id=<successfulSourceRunId> --scope-only --product-category='测试分类' --expected-category-products=1 --apply --new-run
```

分类流程为：选择“指定分类” → 至少等待 5 秒，并确认分类列表连续 1 秒稳定且没有加载遮罩 → 在当前弹窗内按唯一分类 ID 勾选 → 关闭重开核对勾选 → 应用 → 保存 → 预览 → 发布。预览和公开页必须与后台分类产品 ID 集合完全一致；只有勾选状态正确不能判通过。状态保存分类 ID、实际加载等待时间和渲染产品 ID。未发布的失败运行可用相同分类参数执行 `ai:product-list-settings:resume`，继续已有页面。

完整验证六项设置时去掉 `--scope-only`：

```bash
npm run ai:product-list-settings -- --run-id=<newRunId> --history-run-id=<successfulSourceRunId> --product-category='测试分类' --expected-category-products=1 --apply --new-run
```

同一页先应用、保存并预览分类结果，再恢复全部产品，设置名称升序、分页、每页 5 个、关闭星级评价和新配色，最后统一保存、预览、发布并检查公开页。分类阶段证据独立保存在 `category_phase`，恢复执行时跳过已通过阶段。

平铺模式不视为已验证。每轮新建页面和状态保留，需显式执行 cleanup 才会删除。

## HTML 页面上传专项

本专项使用有界面 Chrome、现有持久化登录态和英语测试站点，独立执行：新建页面 → 上传页面 → 选择 HTML → 等待解析 → 页面设置 → 编辑器展示 → 保存 → 重新打开检查持久化 → 预览 → 发布 → 公开页验证。

```bash
npm run page:html-upload
npm run page:html-upload -- --run-id=html-upload-example --file='input/LOCAL_FILE'
npm run page:html-upload:resume -- --run-id=html-upload-example
npm run page:html-upload:status -- --run-id=html-upload-example
```

默认测试文件为 `fixtures/html-upload/pulse-dashboard.html`，来自桌面 HTML 的固定副本，复用脚本无需依赖桌面文件。可用 `--file` 指定其他 `.html` / `.htm` 文件（非空、不超过 10MB）。恢复时核对文件 SHA-256，不能更换文件。每轮页面名称、路径、上传文件名均带 runId，测试数据默认保留。

展示校验先核对源文件核心标题、表格和 SVG 图表已出现，再统一三处内容区尺寸，比较上传区块的正文、结构、链接、图片／图表、关键计算样式和相对布局（默认允许 2px 浮点偏差）。站点页头页尾及编辑器工具栏不进入区块比较。平台自动剥离上传 HTML 的页头页尾；不要求原文件页头页尾保留。三处截图保存为证据，截图本身不作为像素级一致断言。

上传提交前记录检查点，收到任务回执和页面创建回执即持久化。解析最多等 3 分钟；内容连续稳定 3 秒后才保存。恢复优先查询原任务或打开原页面，已创建页面不重复上传、未确认回执不盲目再次提交。上传任务已确认时从“历史记录”按任务 ID 与界面时间核对后恢复；匹配有歧义则停止。

状态：`.state/ai-lifecycle/runs/<runId>/html-upload/state.json`。截图：`output/playwright/html-upload/<runId>/`。中文报告：`reports/html-upload/<runId>/report.html`，并更新 `reports/html-upload/latest.html`，内嵌截图可点击放大。专项不自动加入全量 AI 回归。

## 五、失败与重试

先查看状态和异常报告。确认某个失败区块可以安全重试后：

```bash
npm run retry:block -- --block-id 12345
npm run resume
```

已经是 `added` 或 `published_verified` 的区块会拒绝重置，避免重复添加。

常见情况：

- 提示自动登录失败：检查外部账号配置、代理和站点权限；必要时执行 `npm run auth`，再执行 `npm run resume`。
- 搜索无结果：记录为无结果并继续下一个，不占页面槽位。
- 页面保存失败：自动重试一次；仍失败会停止，避免后续映射错位。
- 页面重名：修改 `pageNamePrefix` 和 `pagePathPrefix`，并使用新的状态目录，或换到干净测试站。
- Chrome 启动失败：确认已经安装 Google Chrome；也可把 `config/run.json` 中 `browser.channel` 覆盖为本机可用的 Chrome 通道。

## 六、替换成新的区块清单

可以直接替换 `inputs/区块排名.xlsx`，但需保持：

- 工作表名为 `Sheet1`，或修改 `rankingSheetName`。
- A 列：区块模板类型。
- B 列：区块 ID。
- C 列：区块名称。
- D 列：使用量，可为空。

脚本当前内置了 8 个模板代表 ID，用来保证模板处理顺序。如果新清单不包含这些代表 ID，需要同步修改 `src/ranking-input.mjs` 中的 `RANKING_TEMPLATE_REPRESENTATIVES`。

替换清单后不要沿用旧 `.state/`。先备份报告，再删除当前解压目录中自己生成的 `.state/`，重新执行 `npm run plan` 和试跑。

## 七、安全边界

- 压缩包不包含账号、密码、Cookie、浏览器登录目录和历史运行结果。
- 所有会写页面的命令内部都要求显式 `--apply`；npm 命令已经代为传入。
- 普通 Excel 区块命令不执行发布；AI `ai:add`/`ai:resume` 按计划执行发布并等待公开页生效，不修改图片、ALT、Title。
- 不要在生产站运行；先在专用测试站执行一页试跑。
