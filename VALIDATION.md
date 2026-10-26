# 验证记录

本次仅做归档、脱敏与离线检查，未连接真实站点执行登录、修改、生成、发布或清理。历史 live 结果位于 `evidence/`，不能替代本次版本的 live 验证。

## 离线测试

| 套件 | 通过 | 失败 | 测试自身跳过 |
|---|---:|---:|---:|
| block-page | 132 | 0 | 1 |
| editor-3 | 184 | 0 | 0 |
| ai-block | 181 | 0 | 0 |
| llms-txt | 2 | 1 | 0 |
| v4-portable | 18 | 0 | 0 |
| permissions | 4 | 0 | 0 |
| permissions-current | 4 | 0 | 0 |
| archive-config-guard | 4 | 0 | 0 |

合计 **529 通过、1 失败、1 项由原测试条件跳过**。此外未选择 15 个依赖本机输入、真实环境或浏览器 fixture 的测试文件；又按名称排除 10 项依赖历史业务输入/状态的断言。这些不计入通过数。完整范围见 `catalog/offline-checks.json`。

唯一失败：`llms-txt/test/config.test.mjs` 中“拒绝缺少代理或无效地址”。已在原目录单独复现：当前校验器允许空代理直连，历史测试仍期望空代理报错。本次保留原逻辑与该失败记录。

## 静态与可携带性检查

- JavaScript、Shell、Python、JSON 语法、相对模块引用以及源文件 SHA-256 对照：执行 `python3 tools/verify-archive.py`。
- TypeScript 5.7.3 对 37 个 TS 文件的语法转换检查通过。
- 权限两个版本的 `--list` 各输出 36 条用例；已将只读列举提前到凭据读取之前，克隆后无需登录即可查看。
- AI 套件锁文件执行 `npm ci --dry-run --ignore-scripts` 通过；常规测试依赖从 npm 安装到临时目录。此检查不等于所有真实浏览器入口都可执行。
- 配置受检入口的 4 项测试通过；缺少配置或仍含示例站点值时，在启动原命令之前报错。
- 扫描已知本机凭据精确值、Token/私钥模式、账号密码字面量、原始站点/代理与个人绝对路径；不保存敏感值。

## 复现离线检查

先安装对应套件依赖。批量测试脚本按根目录 `node_modules` 查找 Playwright Test，测试各套件时 Node 也会检查其自身依赖目录。依赖准备完成后：

```sh
python3 tools/verify-archive.py
python3 tools/offline-check.py
```

批量脚本为保留的 llms.txt 既有失败返回非零退出码，详细日志留在本机临时目录。部分检查使用原环境提供的 `@oai/artifact-tool` 与 Midscene，它们未随归档分发；缺少外部依赖时不能复现相关检查。依赖与自备输入要求见 `DEPENDENCIES.md`。

## 归档调整

仅在归档副本中移除敏感默认值、改用本机配置模板、修复个人路径、补声明原源码所需的 xlsx 依赖，并调整脱敏后的图片/预览域名测试 fixture。真实业务输入与登录态未复制；代码存在差异的版本分别保留。

推送后的远端提交、文件树和重新克隆检查由交付过程另行核对。
