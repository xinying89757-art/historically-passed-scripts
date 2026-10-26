# BUG1004949 管理员登录资产

目录只包含管理员登录脚本、管理员账号配置和登录态输出目录。

默认配置：

- 后台：`https://admin.example.invalid/website.html`
- 英语站点：`http://site.example.invalid`
- 代理：`http://proxy.example.invalid:8080`

运行前安装依赖：

```bash
npm install
npx playwright install chromium
```

有界面登录并保存登录态：

```bash
npm run login
```

无界面登录：

```bash
npm run login:headless
```

成功后登录态保存到 `state/admin.storage.json`。账号配置和登录态文件已设置为仅当前用户可读写；不要提交到代码仓库。
