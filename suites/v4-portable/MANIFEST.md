# 包内容

- `data/新版编辑器区块.csv`：4.0区块源清单，GB18030编码。
- `config/v4-blocks.json`：当前运行配置。
- `scripts/configure.mjs`：交互式切换无代理/代理环境并设置站点。
- `scripts/check-env.mjs`：Node、依赖、CSV、配置和Chrome预检查。
- `src/v4-*.mjs`：区块添加、富文本设置、状态和报告实现。
- `test/v4-*.test.mjs`：不会写入网站的自动化单元测试。
- `.auth`：本机登录状态目录；压缩包中为空。
- `.state`：中断恢复状态目录；压缩包中为空。
- `artifacts`：截图和Playwright Trace目录；压缩包中为空。
- `reports`：CSV和HTML报告目录；压缩包中为空。

版本：1.0.0
