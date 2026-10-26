# Phoenix 设计任务 Playwright 流程

这是从 `YOUR_LOCAL_CREDENTIAL-新运营服务` 主流程和 `YOUR_LOCAL_CREDENTIAL-测试拒绝分支` 拒绝流程实际操作中沉淀的可复用脚本。脚本默认使用有界面 Chromium 和代理，按账号角色完成用户提交资料、管理员审核及分配、设计师制作及提交、用户验收、管理员最终核对。

## 已保存的动作

| 动作 | 登录角色 | 页面操作 |
|---|---|---|
| `user-submit-materials` | 用户 | 找到网站，提交建站资料，处理“确定”“我知道了”“下一步”，填写可识别的表单控件并上传图片，提交审核 |
| `user-resubmit-materials` | 用户 | 资料审核不通过后修改至少一个资料字段并重新提交审核 |
| `admin-approve-materials` | 服务商管理员 | 进入“服务商管理 → 设计管理”，搜索网站并审核通过 |
| `admin-approve-design` | 服务商管理员 | 设计师提交内审后，如停在设计审核中，则审核通过并进入用户审核中 |
| `admin-reject-materials` | 服务商管理员 | 在资料审核中填写拒绝原因并执行审核不通过 |
| `admin-assign-designer` | 服务商管理员 | 勾选设计任务，搜索并分配指定设计师 |
| `designer-start` | 设计师 | 在“待设计”中编辑网站、填写预计完成时间，进入设计中 |
| `designer-submit-review` | 设计师 | 在“设计中”提交内审并确认弹窗 |
| `user-accept` | 用户 | 选择目标网站，点击通过，填写四项 5 分评价及反馈，提交验收 |
| `user-reject` | 用户 | 点击不通过，验证空意见拦截，再填写修改意见和附件提交 |
| `admin-status` | 服务商管理员 | 只读搜索目标网站，输出当前状态和整行信息 |
| `main-flow` | 全部角色 | 按上面的顺序批量执行配置中的所有网站 |
| `reject-branches-flow` | 全部角色 | 覆盖资料拒绝后重提、重新制作、用户验收拒绝，并停在设计修改状态 |

## 安装

```bash
cd ${ARCHIVE_WORKSPACE}/automation/phoenix-design-flow
npm install
```

## 灰度环境预检

灰度环境先使用本地 `config/gray.pac`，再对 HTTP 入口、最终主机和 `X-Via: Ld-Gray` 做只读校验：

```bash
node scripts/check-gray-environment.mjs
```

灰度流程使用 `config/grey-two-sites.example.json`。脚本从 `http://www.leadong.com` 发起访问，允许服务器在同一主机内自动跳转 HTTPS，并以本地 PAC 和 `X-Via: Ld-Gray` 响应头确认灰度链路。

## 配置测试网站

复制示例配置为本地配置：

```bash
cp config/design-flow.example.json config/design-flow.local.json
```

修改 `sites` 数组即可复用到其他测试网站。一个网站支持以下字段：

```json
{
  "name": "网站名称",
  "siteSettingId": "网站ID",
  "designId": "设计任务ID",
  "designComId": "设计企业ID",
  "languageCode": "0",
  "designerName": "s e a y a a",
  "themeNo": "238",
  "primaryColor": "#1E88E5",
  "secondaryColor": "#F5A623",
  "uploadFile": "/绝对路径/测试图片.png",
  "expectedCompletionDays": 7,
  "feedback": "自动化流程验证反馈",
  "materialRejectReason": "资料审核不通过原因",
  "acceptanceRejectReason": "用户验收修改意见",
  "rejectAttachment": "/绝对路径/测试图片.png"
}
```

只有 `name` 是搜索网站必需的。其余 ID 在已知时建议填写，可以让任务定位和用户验收更准确。多个网站写入 `sites` 数组后，单个动作会按顺序批量执行。

建站资料页按以下 8 个固定模块执行。脚本会逐模块填写、保存、等待弹窗、点击“下一步”，并确认右侧状态图标已经变为勾选：

```json
{
  "materialSectionLabels": [
    "网站风格",
    "首页内容",
    "公司资料",
    "产品资料",
    "新闻资料",
    "其他页面资料",
    "联系资料",
    "网站优化"
  ]
}
```

产品资料和新闻资料会通过页面自带的跨域上传 iframe 选择本地文件。点击“添加附件”后固定等待 2 秒，再操作 iframe 中的文件控件和“开始上传”；产品分类、产品详情、新闻分类和新闻资料分别上传。联系资料使用符合页面校验格式的电话和邮箱，网站优化填写全部 5 个关键词输入框。

全空白站点还会显式处理以下控件：网站风格主题编号、首页主色/辅色、企业 LOGO、Banner 必填素材。直接文件上传后脚本会等待页面写回文件 ID/名称/URL，并统一同名隐藏字段，避免页面保留空字段导致误报。最终模块出现“资料已完成，请点击提交审核”时，会先关闭完成提示，再执行统一的提交审核及二次确认。

联系资料只填写必填字段和符合国际格式的电话，非必填社交链接、邮编、传真、QQ 不写入无效测试文本。附件显示 100% 后会继续等待页面回写；保存未发出请求时最多重试三次。侧栏完成图标仅作提示，最终以页面 `/customerInfo/check` 返回 `1` 为提交依据。

## 设置账号密码

账号名称可以放在配置里，密码默认从环境变量读取，避免硬编码到脚本：

```bash
export PHOENIX_USER_PASSWORD='用户密码'
export PHOENIX_DESIGNER_PASSWORD='设计师密码'
export PHOENIX_ADMIN_PASSWORD='管理员密码'
```

用户和设计师密码相同时，可以只设置 `PHOENIX_USER_PASSWORD`；示例配置已让设计师密码回退到该变量。

每个动作、每个角色都创建全新的 Browser Context，结束后立即关闭。因此用户、管理员、设计师之间的 Cookie、localStorage 和 sessionStorage 完全隔离，不会串号。

## 运行

默认使用有界面浏览器：

```bash
npm run flow -- --config config/design-flow.local.json --action admin-status
npm run flow -- --config config/design-flow.local.json --action user-submit-materials
npm run flow -- --config config/design-flow.local.json --action user-resubmit-materials
npm run flow -- --config config/design-flow.local.json --action admin-approve-materials
npm run flow -- --config config/design-flow.local.json --action admin-reject-materials
npm run flow -- --config config/design-flow.local.json --action admin-assign-designer
npm run flow -- --config config/design-flow.local.json --action designer-start
npm run flow -- --config config/design-flow.local.json --action designer-submit-review
npm run flow -- --config config/design-flow.local.json --action user-accept
npm run flow -- --config config/design-flow.local.json --action user-reject
```

运行完整主流程：

```bash
npm run flow -- --config config/design-flow.local.json --action main-flow
```

`main-flow` 会在设计师提交内审后自动读取管理员状态：已进入“用户审核中”时直接继续；处于“设计审核中/设计师审核中”时先由管理员审核通过，再进入用户验收。

1525 两站点配置可按网站名称精确执行。例如只跑全审核通过站点：

```bash
npm run flow -- --config config/1525-two-sites.example.json --action main-flow --site 'YOUR_LOCAL_CREDENTIAL-1525新测试'
```

1550 全通过站点使用独立配置：

```bash
npm run flow -- --config config/1550-pass.example.json --action main-flow --site 'YOUR_LOCAL_CREDENTIAL-1550测试通过'
```

运行完整拒绝分支并停在设计修改状态：

```bash
npm run flow -- --config config/reject-branches.example.json --action reject-branches-flow --site 'YOUR_LOCAL_CREDENTIAL-测试拒绝分支'
```

该流程会先通过管理员页面读取并记录网站 ID、设计任务 ID、设计企业 ID和当前状态。如果不是“资料审核中”，只通过可见的“设置状态”弹窗准备前置状态；准备操作会在报告中单独记录。用户验收不通过时，脚本会先空意见提交并确认没有 POST 请求，再填写有效意见和附件提交。

只运行配置中的一个网站：

```bash
npm run flow -- --config config/design-flow.local.json --action admin-status --site 'YOUR_LOCAL_CREDENTIAL-新运营服务'
```

无界面运行时追加 `--headless`。不使用代理时执行前设置：

```bash
export UI_PROXY=none
```

## 输出

每次运行都会把网站、动作、开始/结束时间、状态或错误写入：

```text
output/playwright/phoenix-design-flow-*.json
```

这些时间和 `siteSettingId`、`designId` 可以直接用于后续批量核查推送日志。

失败时还会保存 `failure-*.png` 全页截图，并把当前 URL、资料模块状态、必填控件及附件字段写入同一 JSON 报告，便于复用脚本时定位新套餐差异。

## 安全与状态约束

- `admin-status` 是只读动作；其他动作会真实改变测试网站状态。
- `reject-branches-flow` 只允许通过 `--site` 精确选择一条记录，最终不会自动恢复“用户通过”。
- 脚本按网站精确名称定位，建议每次操作前先运行 `admin-status`。
- `user-submit-materials` 会自动填写当前可见的普通文本框、下拉框、富文本、单选框和上传控件。遇到新增的定制控件时，脚本会在未出现“提交审核”时停止，不会伪造成功。
- “提交审核”会先调用页面校验，再点击确认弹窗内的第二个“提交审核”；两次请求都成功后才记录为资料审核中。
- 设计任务优先使用 `designId` 定位，避免网站名称在表格中与企业名称拼接导致误匹配。
- 本地密码配置应使用 `config/*.local.json`，该路径已加入 `.gitignore`。

## 服务商域名管理流程

`scripts/phoenix-domain-flow.mjs` 保存了本次服务商系统“域名管理”的可复用操作。页面中的“域名状态：可用/不可用”分别作为启用/停用操作执行。

完整流程覆盖服务商域名用例 N1-N6，依次执行：

1. 添加测试域名和备案号。
2. 修改备案号。
3. 将测试域名设为“不可用”（停用）。
4. 将测试域名恢复为“可用”（启用）。
5. 将测试域名切换为默认域名。
6. 将原系统域名恢复为默认域名。
7. 再次停用测试域名，准备 N6 前置状态。
8. 一次保存同时把测试域名升为默认并恢复为“可用”。
9. 再次将原系统域名恢复为默认域名。
10. 删除时先取消并验证域名仍存在，再次删除并确认，恢复测试前状态。

复制配置并设置管理员密码：

```bash
cp config/domain-flow.example.json config/domain-flow.local.json
export PHOENIX_ADMIN_PASSWORD='管理员密码'
```

运行完整流程：

```bash
npm run domain-flow -- --config config/domain-flow.local.json --action full-flow
```

也可以单独执行 `add`、`edit`、`disable`、`enable`、`set-test-default`、`set-test-default-and-enable`、`restore-default`、`delete`；`unbind`、`bind` 作为兼容别名继续可用。默认使用有界面 Chromium 和配置中的代理。每一步会在 `output/playwright/` 保存截图，最终生成包含北京时间、请求 URL、HTTP 状态和请求体的 JSON 报告。

若测试因页面加载波动在中途停止，可使用 `resume-after-add` 从新增后的编辑步骤继续，或使用 `resume-after-test-default` 从首次升默认后的恢复步骤继续。恢复动作只用于已核实前置状态的测试站点；正常执行仍使用 `full-flow`。

`set-test-default-and-enable` 要求测试域名处于“不可用、非默认”状态，并在同一次提交中将其改为“可用、默认”，对应 N6。`delete` 会先验证取消删除不产生删除结果，再确认删除，对应 N2。

灰度环境使用 `config/domain-flow.gray.example.json`。该配置从 `http://www.leadong.com/website.html` 进入，并通过本地 `gray.pac` 使用 `http://proxy.example.invalid:8080/gray.pac` 对应的灰度规则。执行前先复制为私有配置并确认网站信息：

```bash
cp config/domain-flow.gray.example.json config/domain-flow.gray.local.json
export PHOENIX_ADMIN_PASSWORD='管理员密码'
node scripts/check-gray-environment.mjs
npm run domain-flow -- --config config/domain-flow.gray.local.json --action full-flow
```
