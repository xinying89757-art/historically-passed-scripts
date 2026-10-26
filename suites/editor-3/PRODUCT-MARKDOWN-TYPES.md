# Product Description 类型设置验证

脚本：`src/product-markdown-types.mjs`  
命令：`npm run product:markdown-types`

脚本默认在有界面 Chromium 中打开后台产品编辑器，根据当前 Product Description 动态识别标题、文本格式、列表、引用、不同语言代码块、表格及特殊节点。代表元素记录节点路径和文本特征，并在操作前重新定位。账号密码只从运行环境或 `UI_ADMIN_CONFIG` 指定的私有 JSON 文件读取；不会写入结果文件。默认直连，只有显式设置 `UI_PROXY` 时才使用代理。

## 运行

在本目录下执行命令，并在当前进程环境提供：

- `UI_ADMIN_ACCOUNT`、`UI_ADMIN_PASSWORD`；或
- `UI_ADMIN_CONFIG`，指向含 `account`（也接受 `username` 或 `loginName`）和 `password` 字段的本地私有 JSON 文件。

可选环境变量：`UI_BASE_URL`、`PRODUCT_NAME`、`UI_ADMIN_LOGIN_URL`、`UI_ADMIN_URL`、`UI_PROXY`、`UI_PROFILE_DIR`。脚本默认使用测试站点 `http://site.example.invalid` 和产品 `测试markdown`。默认 Chromium profile 保存在 `outputs/product-markdown-types/browser-profile/`，各批次重用站点登录会话；Cookie 等浏览器会话数据不会放进报告。需要隔离会话时可将 `UI_PROFILE_DIR` 指向另一个本机目录。

仅扫描当前类型清单、不修改编辑器：

```sh
npm run product:markdown-types:scan
```

只诊断一个类型可使用 `--type "标题 H3"`（兼容环境变量 `UI_FOCUS_TYPE`）；诊断不会保存产品。用 `--type "标题 H3" --inspect-options` 可读取目前已接入的有限菜单清单。`--setting "字体颜色"` 需同时指定 `--type`，仅检查该类型对应设置。文本类型的单设置保存批次可使用 `--type "普通段落" --setting "加粗" --value on --save-batch`；保存前必须通过设置效果和原文完整性检查，保存后会重开后台并核对前台。`--value` 用于二态格式（`on`/`off`）、字号/行距/对齐选项或 HEX 颜色。类型转换和特殊节点目前只做诊断，不会用单设置保存批次提交。`--no-save` 可执行完整后台诊断但禁止保存。运行 `npm run product:markdown-types:self-test` 可用重排、嵌套、多表格、多图片、Mermaid 和无语言代码夹具检查发现逻辑。

目前脚本提供全量类型扫描、类型级设置诊断、单设置诊断和单文本设置保存批次。它尚未完成全部编辑器控件的选项映射，也没有为图片、表格和分隔线开放逐设置保存批次；此类未实现入口必须视为未覆盖/受阻，不能计作通过。字号菜单存在标题预设和自定义入口；有限选项及数值边界尚未全部逐项验收。转换菜单目前仅在当前编辑器里试用并恢复结构，尚未逐选项保存核对前台。全量运行会留存 HTML、结构 JSON 和后台截图，比较编辑前后的原文与空白；保存后重新打开后台核对保留情况，并比较前后台代表标记的关键计算样式。报告区分未出现类型、静态内容不支持、自动化受阻和设置失败。每次运行输出到 `outputs/product-markdown-types/<run_id>/`。字号操作必须保留既有颜色、背景、格式标记和链接；发生附带变化时停止保存并按产品缺陷计失败。

每次运行在工作区 `outputs/product-markdown-types/<run_id>/` 生成类型级 `result.json`、HTML 基线/备份、截图和适用的前台证据。运行结果不包含凭据。
