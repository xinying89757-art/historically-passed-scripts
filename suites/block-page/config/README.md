# 配置说明

压缩包中的配置是模板。第一次运行前，请复制或直接编辑对应 JSON，将以下占位内容替换为实际值：

- 输入文件路径：使用 `input/` 下的相对路径；
- `siteName`、`siteLanguage`：实际站点和语言；
- `publicBaseUrl`、`siteHost`：测试站正式域名；
- `proxyServer`：需要代理时填写，例如 `http://host:port`；不需要代理时留空；
- 页面前缀和页面路径前缀：按本批次规则填写；
- Growth Engine 的 `growthEngineSite` 和 `editorBackfill`：填写实际站点和回填页面。

登录状态不会写入配置，执行对应的 `auth` 命令后保存在本机 `.auth/`。

不要提交包含账号、Cookie、token 或真实业务凭据的配置文件。
