# BUG1004949 可复用 UI 自动化脚本

## 运行环境

- 后台：`https://admin.example.invalid/website.html`
- 英语前台：`http://site.example.invalid`
- HTTP 代理：`http://proxy.example.invalid:8080`
- Node.js、npm 和 Playwright Chromium

## 账号文件

- `fixtures/local-test-config.json`：管理员、会员、员工和页面密码配置
- `fixtures/admin.storage.json`：管理员登录态；失效时脚本会通过管理员配置自动重新登录

账号配置文件包含敏感信息，仅限本机测试使用。脚本不会把账号或密码写入报告、日志和错误信息。

## 安装与运行

```bash
cd BUG1004949-reusable-runner-20260916
npm install

# 有界面完整执行
HEADLESS=0 npm run test:nonblocked

# 无界面完整执行
HEADLESS=1 npm run test:nonblocked

# 单条用例
npm run test:case -- 用例-0017

# 按分组执行
npm run test:group -- access-control

# 仅恢复上一次遗留状态
npm run test:recover
```

脚本使用一个 Chromium 进程；后台修改单并发，前台只读验证最多两个 Worker。每轮执行结束会恢复页面权限和内容 URL。

## 本版本已验证

有界面完整运行：40 条结果、36 条实际自动执行、35 条通过、1 条业务不通过、3 条环境阻塞、0034 待产品确认、0 条自动化失败，后台恢复成功。
