# BUG1004949 内容管理后台操作资产

核心脚本是 `support/backend-state.ts`，用于通过领动云平台的内容管理后台查找和操作产品、文章、图册、视频及其分类，支持：

- 读取并保存页面权限
- 设置密码、会员、员工、表单和公开访问
- 设置系统 URL 或自定义 URL
- 保存后重新进入编辑页校验持久化结果
- 记录基线并在恢复阶段还原原权限和 URL

运行所需入口：

- `tests/scenario-setup.spec.ts`：按 `UI_SCENARIO_GROUP` 配置后台场景
- `tests/recovery.spec.ts`：恢复运行前记录的后台状态

示例：

```bash
npm install
npx playwright install chromium
UI_SCENARIO_GROUP=custom-url npm run backend:setup
npm run backend:recover
```

默认后台地址为 `https://admin.example.invalid`，代理和前台地址可通过 `UI_PROXY`、`UI_BASE_URL`、`UI_ADMIN_BASE_URL` 覆盖；设置 `UI_PROXY=none`、`direct` 或 `off` 时直连。管理员登录态在 `fixtures/admin.storage.json`，账号配置在 `fixtures/local-test-config.json`，均已设置为仅当前用户可读写。
