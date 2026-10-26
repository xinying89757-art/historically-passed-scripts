# 4.0区块添加与H2测试数据自动化

这个压缩包只负责两件事：

1. 从 `data/新版编辑器区块.csv` 读取“图片集、图文”区块，按区块ID搜索并添加到4.0编辑器页面，每页10个。
2. 逐区块打开右侧设置栏，悬浮第一张图片并点击编辑，把第一张图片下所有可识别富文本改成唯一中文文字，并统一设置为H2。

脚本使用带界面的Google Chrome，执行时可以直接看到操作。它不会发布网站，也不会操作增长引擎。

## 一、运行条件

- macOS、Windows或Linux。
- Node.js 20或更高版本。
- Google Chrome。
- 对目标4.0站点有编辑权限。
- 同一站点同时只能有一个人运行写入脚本。

压缩包不包含账号、Cookie、Chrome登录状态、历史运行状态和历史截图。每台电脑第一次使用时必须自行登录。

## 二、首次安装

解压后，在当前目录打开终端：

```bash
npm install
npm run configure
npm run check
```

`npm run configure`会询问：

- 不挂代理，还是使用测试环境代理。
- “我的网站”中的4.0站点名称。
- 站点语言。
- 站点公开域名；只用于报告，不影响本次编辑器操作。

环境对应关系：

| 模式 | 入口 | 代理 |
|---|---|---|
| 不挂代理 | `https://www.leadong.com/website.html` | 不使用 |
| 测试环境 | `https://admin.example.invalid/website.html` | 默认 `http://proxy.example.invalid:8080` |

如果站点、代理或网址发生变化，可重新执行 `npm run configure`，也可以直接编辑 `config/v4-blocks.json`。

## 三、登录

```bash
npm run v4:block:auth
```

脚本会打开独立的可见Chrome。人工登录并回到“我的网站”列表页，再在终端按Enter。登录状态只保存在本机 `.auth` 目录，不要把该目录发给别人。

## 四、添加4.0区块

先检查CSV和计划：

```bash
npm run v4:block:plan
```

第一次建议只试跑1页：

```bash
npm run v4:block:run:poc
```

确认页面已正确添加10个区块、右上角保存成功后，再继续全量：

```bash
npm run v4:block:run
```

中断或登录失效后，重新登录并续跑：

```bash
npm run v4:block:auth
npm run v4:block:resume
```

查看状态和报告：

```bash
npm run v4:block:status
```

报告目录由 `config/v4-blocks.json` 中的 `paths.v4ReportsDir` 决定。主要文件是：

- `v4-block-page-mapping.csv`：成功区块与页面、槽位、编辑器节点的映射。
- `v4-block-failures.csv`：搜索、添加、渲染和保存异常。
- `v4-block-report.html`：可视化汇总。

注意：同名页面已存在但本地没有对应 `.state` 状态时，不要直接重跑添加，否则可能重复建页。应使用空白测试站，或先在配置中更换页面名称和路径前缀。

## 五、给第一页设置H2测试数据

必须先完成区块添加，因为测试数据脚本依赖上一步生成的区块与编辑器节点映射。

生成第一页清单：

```bash
npm run v4:data:first:plan
```

执行第一页：

```bash
npm run v4:data:first:run
```

中断续跑和查看状态：

```bash
npm run v4:data:first:resume
npm run v4:data:first:status
```

第一页固定为 `新版图片集区块测试-001`。每个区块执行：

1. 点击区块，打开右侧设置栏。
2. 悬浮第一张图片，点击铅笔编辑按钮。
3. 只处理第一张图片下的富文本；如果有多个富文本，全部处理。
4. 写入 `新版区块标题测试-区块ID-区块名称-第XX处`。
5. 把级别设置为H2。
6. 保存页面并重新打开验证。

没有第一张媒体、没有编辑按钮或没有目标富文本的区块不会乱点，会进入不支持清单。

## 六、给剩余页面设置H2测试数据

先生成剩余页面任务：

```bash
npm run v4:data:batch:plan
```

建议先试跑1页：

```bash
npm run v4:data:batch:run:poc
```

确认后执行全部剩余页面：

```bash
npm run v4:data:batch:run
```

中断续跑和查看状态：

```bash
npm run v4:data:batch:resume
npm run v4:data:batch:status
```

报告中会区分：

- `verified`：保存后重新打开，文字和H2均正确。
- `unsupported_no_media_item`：没有可处理的第一张媒体。
- `unsupported_no_media_edit`：第一张图片没有编辑入口。
- `unsupported_no_rich_text`：图片编辑项中没有目标富文本。
- 其他状态：自动化定位、设置、保存或重开验证异常，可用resume重试。

## 七、常见问题

### 登录失效

重新运行 `npm run v4:block:auth`，然后运行对应的resume命令。不要删除 `.state`。

### 浏览器中看不到操作

确认 `config/v4-blocks.json` 中：

```json
"browser": {
  "headless": false,
  "channel": "chrome",
  "slowMo": 180
}
```

### 换电脑接着跑同一批任务

除整个脚本目录外，还要复制当前环境对应的 `.state/*.json`；不要复制 `.auth`，接收方自行登录。配置、CSV和状态文件必须属于同一环境。

### 重新从头跑

建议解压一份全新的压缩包并使用空白测试站。不要随意删除正在使用的状态文件，否则脚本无法识别已经创建的页面和区块。

## 八、安全边界

- 写入命令内部已经显式带有 `--apply`。
- 脚本不会发布网站。
- 脚本不会修改增长引擎。
- 运行前先用计划和单页试跑确认站点、环境、页面名称及区块范围。
- `.auth`、`.state`、`artifacts`和`reports`默认不应提交到代码仓库或发送给无关人员。

## 九、自检

```bash
npm test
```

该命令会验证CSV筛选、页面/区块状态、唯一中文标题生成、H2规则、批量页面选择及报告生成逻辑，不会打开浏览器，也不会修改网站。
