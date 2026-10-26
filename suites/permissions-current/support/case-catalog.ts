export type CaseGroup = "access-control" | "custom-url" | "redirects" | "error-pages";
export type CaseDefinition = {
  id: string;
  title: string;
  group: CaseGroup;
  priority: "P0" | "P1";
  status: "ready" | "environment_blocked" | "product_confirmation";
  scenario: string;
};

const titles: Record<string, string> = {
  "用例-0001": "产品详情密码访问并验证后展示内容",
  "用例-0002": "文章详情密码访问并验证后展示内容",
  "用例-0003": "受保护详情页查询参数保留",
  "用例-0004": "手机端受保护详情页显示密码页",
  "用例-0005": "连续访问受保护 URL 三次均显示密码页",
  "用例-0007": "无限制产品详情直接展示",
  "用例-0008": "未验证受保护 URL 显示密码页",
  "用例-0009": "密码验证后查看受保护内容",
  "用例-0010": "未登录会员访问跳转登录页",
  "用例-0011": "VIP 会员访问显示内容",
  "用例-0012": "会员等级不足显示无权限页",
  "用例-0013": "非员工访问显示员工提示页",
  "用例-0014": "员工登录后查看员工保护内容",
  "用例-0015": "未填写表单显示表单页",
  "用例-0016": "填写表单后查看内容",
  "用例-0017": "自建页面密码访问并验证",
  "用例-0018": "自建页面会员访问跳转登录",
  "用例-0019": "自建页面无限制访问",
  "用例-0022": "系统自定义 URL 参数不能绕过保护",
  "用例-0023": "真实请求地址参数不能绕过保护",
  "用例-0024": "直接访问系统自定义 URL 不能越权",
  "用例-0025": "直接访问密码验证页",
  "用例-0026": "A 页验证不影响 B 页保护",
  "用例-0027": "刷新后仍显示密码页",
  "用例-0028": "产品详情自定义 URL 内容和标题",
  "用例-0029": "三条文章详情自定义 URL 内容和标题",
  "用例-0030": "产品分类列表和分页",
  "用例-0031": "文章分类列表和分页",
  "用例-0032": "图库详情自定义 URL",
  "用例-0033": "图库分类自定义 URL",
  "用例-0034": "视频详情自定义 URL",
  "用例-0035": "视频分类自定义 URL",
  "用例-0036": "带目录和根目录自定义 URL",
  "用例-0037": "系统 URL 跳转到自定义 URL",
  "用例-0038": "带目录和根目录分类分页",
  "用例-0039": "短链接跳转目标页面",
  "用例-0043": "不存在链接显示自定义 404",
};

const accessIds = [
  "用例-0001", "用例-0002", "用例-0003", "用例-0004", "用例-0005", "用例-0008", "用例-0009",
  "用例-0010", "用例-0011", "用例-0012", "用例-0013", "用例-0014", "用例-0015", "用例-0016",
  "用例-0017", "用例-0018", "用例-0022", "用例-0023", "用例-0024", "用例-0025", "用例-0026",
  "用例-0027",
];
const customUrlIds = [
  "用例-0007", "用例-0019", "用例-0028", "用例-0029", "用例-0030", "用例-0031", "用例-0032",
  "用例-0033", "用例-0035", "用例-0036", "用例-0038",
];
const blockedIds = new Set(["用例-0006", "用例-0020", "用例-0021"]);
const productConfirmationIds = new Set(["用例-0034"]);
const p0Ids = new Set(["用例-0001", "用例-0002", "用例-0008", "用例-0010", "用例-0012", "用例-0013"]);

export const allCases: CaseDefinition[] = [
  ...accessIds.map((id) => ({ id, title: titles[id], group: "access-control" as const, priority: p0Ids.has(id) ? "P0" as const : "P1" as const, status: "ready" as const, scenario: id })),
  ...customUrlIds.map((id) => ({ id, title: titles[id], group: "custom-url" as const, priority: "P1" as const, status: "ready" as const, scenario: id })),
  { id: "用例-0037", title: titles["用例-0037"], group: "redirects", priority: "P1", status: "ready", scenario: "用例-0037" },
  { id: "用例-0039", title: titles["用例-0039"], group: "redirects", priority: "P1", status: "ready", scenario: "用例-0039" },
  { id: "用例-0043", title: titles["用例-0043"], group: "error-pages", priority: "P1", status: "ready", scenario: "用例-0043" },
  ...[...blockedIds].map((id) => ({ id, title: id === "用例-0006" ? "系统 URL 密码访问" : id === "用例-0020" ? "CP 页自定义 URL" : "CP 页权限访问", group: "custom-url" as const, priority: "P1" as const, status: "environment_blocked" as const, scenario: id })),
  ...[...productConfirmationIds].map((id) => ({ id, title: titles[id], group: "custom-url" as const, priority: "P1" as const, status: "product_confirmation" as const, scenario: id })),
];

export const readyCases = allCases.filter((item) => item.status === "ready");
export const blockedCases = allCases.filter((item) => item.status === "environment_blocked");
export const productConfirmationCases = allCases.filter((item) => item.status === "product_confirmation");

export function selectCases(caseId?: string, group?: CaseGroup): CaseDefinition[] {
  const selected = readyCases.filter((item) => (!caseId || item.id === caseId) && (!group || item.group === group));
  if (caseId && selected.length === 0) throw new Error(`Unknown or blocked case: ${caseId}`);
  if (group && selected.length === 0) throw new Error(`No ready cases in group: ${group}`);
  return selected;
}

if (readyCases.length !== 36 || new Set(readyCases.map((item) => item.id)).size !== 36) {
  throw new Error(`BUG1004949 catalog must contain 36 unique runnable cases; found ${readyCases.length}`);
}
