# 领动 Playwright 登录脚本

独立运行的登录脚本，提取自已使用的 AI UI 自动化项目。使用有界面 Google Chrome，默认直连。

## 包含的流程

启动持久化 Chrome → 打开管理入口 → 检查登录态 → 必要时填写账号密码并登录 → 悬浮头像 → 点击“返回领动云平台”（进入中台）→ 确认进入网站管理入口 → 保存登录态。

头像及云平台操作位于 `auth.mjs` 的 `enterCloudPlatform()`：

```js
const avatar = page.locator('.wrap-login-container, .wrap-login-dropdown').first();
await avatar.hover();
await page.getByRole('link', { name: /返回.*领动云平台/ }).first().click();
```

实际模块会先判断头像、菜单入口是否可见；登录后已直接进入平台时允许跳过返回入口。复用有效登录态时不重新填写账号密码。

## 文件

- `login.mjs`：可直接运行的浏览器启动入口；确认进入平台后默认退出。
- `auth.mjs`：原项目的登录模块，包含自动登录、悬浮头像进入平台、重试及登录态保存。
- `package.json`：Playwright 依赖及运行命令。
- `.env.example`：账号密码配置模板。
- `.gitignore`：排除凭据及本地登录态。

## 安装和运行

需要 Node.js 20.6 或以上版本，以及已安装的 Google Chrome。终端进入解压后的脚本目录：

```bash
npm install
cp .env.example .env.local
```

打开 `.env.local`，填写测试账号和密码：

```dotenv
BUG1004949_ADMIN_ACCOUNT=你的测试账号
BUG1004949_ADMIN_PASSWORD=你的测试密码
```

运行，并在成功后保留浏览器供查看：

```bash
node --env-file=.env.local login.mjs --keep-open
```

手动关闭浏览器窗口即可结束。需要登录成功后自动退出时：

```bash
node --env-file=.env.local login.mjs
```

如果账号密码已经通过系统环境变量导出，也可执行 `npm run login` 或 `npm run login:keep-open`。

## 当前入口

- 登录页：`https://www.leadong.com/login.html`
- 云平台／中台网站管理入口：`https://www.leadong.com/website.html`

可用 `UI_ADMIN_LOGIN_URL`、`UI_ADMIN_URL` 覆盖入口。也可以通过 `BUG1004949_ADMIN_CONFIG` 指定外部 JSON 凭据文件，其中使用 `account`、`password` 两个字段。每项凭据优先使用对应环境变量，未设置时再读取 JSON。

## 登录态与重试

默认浏览器用户目录为脚本目录下的 `.auth/chrome-profile`，每次使用同一目录即可复用登录态。另会导出 `.auth/admin.storage.json` 供其他 Playwright 用例复用。当前入口使用持久化用户目录恢复登录，并不会将导出的 JSON 再次导入同一上下文。

登录失效时自动重新登录，最多尝试两次。单个页面导航等待上限为 30 秒。`login.mjs` 默认只完成登录和平台入口验证；站点切换及 AI 操作由后续测试脚本执行。

`UI_PROFILE_DIR` 可以覆盖浏览器用户目录，`UI_STORAGE_STATE` 可以覆盖导出的登录态路径。相对覆盖路径按终端当前目录解析。不要让两个进程同时使用同一个浏览器用户目录。

## 模块复用

在已有 Playwright 测试中可导入：

```js
import { ensureAuthenticated, enterCloudPlatform } from './auth.mjs';

await page.goto(config.auth.adminUrl, { waitUntil: 'domcontentloaded' });
await ensureAuthenticated(page, context, config);

// 需要单独触发头像菜单返回平台时：
await enterCloudPlatform(page);
```

账号密码填在本机 `.env.local` 或外部配置文件中。打包内容不包含账号密码、Cookie 或浏览器登录态。
