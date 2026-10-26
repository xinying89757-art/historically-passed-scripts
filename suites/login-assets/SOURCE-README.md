# BUG1004949 管理员登录资产

本文件夹只包含管理员登录脚本、管理员账号配置和登录态输出目录。

默认后台入口：`https://admin.example.invalid/website.html`

默认英语站点：`http://site.example.invalid`

默认代理：`http://proxy.example.invalid:8080`

运行：

```bash
npm install
npm run login
```

无界面登录：

```bash
npm run login:headless
```

成功后登录态保存到 `state/admin.storage.json`。如需不使用代理，可执行：

```bash
UI_PROXY=none npm run login
```

管理员登录后，脚本会悬浮右上角头像进入“领动云平台”，再打开建站后台并确认英语站点入口存在。
