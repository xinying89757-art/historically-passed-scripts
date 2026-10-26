# 历史跑通的脚本

历史 UI 自动化脚本归档，共 **15 套**。覆盖区块/H 标签、增长引擎、AI 区块、页面权限与 URL、llms.txt、产品描述与 Markdown、Phoenix 设计流程、登录、FAQ 回放及来源渠道浏览器访问。

收录的是有历史成功流程的套件与必要依赖。同一套件也可能包含失败、阻塞或未验证分支，请按 [脚本清单](INVENTORY.md) 与 [脱敏历史证据](evidence/) 判断覆盖。历史报告没有完整源码版本对应关系；当前公开版本没有重新连接真实站点验证。

## 开始使用

1. 安装 Node.js 22+，进入所需 `suites/<套件>/`；有 `package-lock.json` 时执行 `npm ci`，否则执行 `npm install`。
2. 阅读该套件的 README 和 SOURCE-README。将示例配置中的站点、页面、测试产品、输入路径和 `YOUR_*` 替换为自己的测试环境。字段结构保留，真实业务清单不分发。
3. 凭据只放在被忽略的本机文件或环境变量中，重新登录生成本机状态。权限套件的角色配置和登录套件均提供 `*.example.json`。
4. 浏览器流程使用根目录受检入口，例如：

```sh
node tools/run-live.mjs block-page plan --archive-config config/default.json
node tools/run-live.mjs phoenix flow --archive-config config/design-flow.local.json -- --action main-flow --config config/design-flow.local.json
```

入口会检查套件、命令以及指定的本机配置是否仍含占位值；缺少配置时在启动浏览器前报错。它不代替各套件的字段校验。`--archive-config` 应指向实际使用的配置，原脚本 `--config` 等参数仍在 `--` 后传递。

浏览器用例可能创建页面、保存数据、修改权限、发布网站或消耗 AI 额度。先阅读具体命令的原说明，再在自己的测试站运行；归档不设置自动执行真实环境的 CI。

## 环境与依赖

常规套件使用 Playwright / Playwright Test；Chrome 型脚本需要 Google Chrome，其余可执行 `npx playwright install chromium`。AI 设置专项额外使用 ExcelJS 与 Midscene。FAQ Shell 回放还需要 Playwright CLI 与已打开的浏览器页面。

部分历史 XLSX 报告/输入解析以及来源渠道脚本依赖外部 **`@oai/artifact-tool` 运行时**。该运行时不包含在此仓库，不假定公开 npm 可安装。详见 [依赖和输入说明](DEPENDENCIES.md)。缺少时相应入口不能完整执行；独立单元检查仍可运行。

## 文件

- [INVENTORY.md](INVENTORY.md)：套件用途、命令、证据与已知限制。
- [DEPENDENCIES.md](DEPENDENCIES.md)：安装方式、外部运行时和输入文件要求。
- [VALIDATION.md](VALIDATION.md)：本次离线检查与历史 live 证据的区别。
- `catalog/provenance.json`：源相对路径、源 SHA-256 与脱敏后 SHA-256。
- `catalog/discovery.json`：递归发现的 1321 个脚本及分类，其中 2 个冗余快照与已收录文件源码完全一致。
- `evidence/`：788 条历史记录的白名单摘要，仅保留状态、计数、用例编号、时间及源文件哈希。

保留独立可运行套件所需的公共模块副本；完全相同的历史执行快照按哈希映射去重。行为有差异的交付版本分别保留。

账号、密码、Token、Cookie、浏览器目录、原始截图、网络记录、真实业务工作簿、依赖目录与原 Git 历史均不上传。未新增开源许可证。
