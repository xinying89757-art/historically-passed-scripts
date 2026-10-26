import path from "node:path";
import fs from "node:fs";

export const runnerRoot = path.resolve(import.meta.dirname, "..");
export const siteBaseUrl = process.env.UI_BASE_URL ?? "http://site.example.invalid";
export const adminBaseUrl = process.env.UI_ADMIN_BASE_URL ?? "https://admin.example.invalid";
export const proxyUrl = process.env.UI_PROXY ?? "http://proxy.example.invalid:8080";
export const proxyOptions = proxyUrl && !["none", "direct", "off"].includes(proxyUrl.toLowerCase())
  ? { server: proxyUrl }
  : undefined;
export const adminStorageState = process.env.UI_ADMIN_STORAGE_STATE ?? path.join(runnerRoot, "fixtures", "admin.storage.json");
const localTestConfig = JSON.parse(fs.readFileSync(path.join(runnerRoot, "fixtures", "local-test-config.json"), "utf8")) as {
  admin: { account: string; password: string };
  pagePassword: string;
};

export const credentials = {
  admin: {
    account: process.env.BUG1004949_ADMIN_ACCOUNT ?? localTestConfig.admin.account,
    password: process.env.BUG1004949_ADMIN_PASSWORD ?? localTestConfig.admin.password,
  },
  pagePassword: process.env.BUG1004949_PAGE_PASSWORD ?? localTestConfig.pagePassword,
};

export const fixturePaths = {
  product: "/bug1004949/product.html",
  productOne: "/bug1004949/product-one.html",
  article: "/bug1004949/article.html",
  member: "/bug1004949/member.html",
  form: "/bug1004949/form.html",
  passwordPage: "/bug1004949/password.html",
  publicPage: "/bug1004949/public.html",
  productCategory: "/bug1004949/product-category.html",
  productCategoryPage2: "/bug1004949/product-category-p2.html",
  articleCategory: "/bug1004949/article-category.html",
  articleCategoryPage2: "/bug1004949/article-category-p2.html",
  gallery: "/bug1004949/gallery.html",
  galleryCategory: "/bug1004949/gallery-category.html",
  video: "/bug1004949/video.html",
  videoDefault: "/video-one-example-item.html",
  videoCategory: "/bug1004949/video-category.html",
  productDirectory: "/bug1004949/product-directory.html",
  productRoot: "/product-root.html",
  productShort: "/short.html",
  productSystem: "/example-product-example-item.html",
  productCategoryRoot: "/product-category-root.html",
  productCategoryRootPage2: "/product-category-root-p2.html",
  articleCategoryRoot: "/article-category-root.html",
  articleCategoryRootPage2: "/article-category-root-p2.html",
  notFound: "/tests/nonexistent-bug1004949.html",
};

type RuntimeState = {
  run_id?: string;
  url_token?: string;
  custom_urls?: {
    article_0029?: Array<{ title: string; path: string }>;
  };
};

function readRuntimeState(): RuntimeState | undefined {
  const stateFile = process.env.UI_RUNTIME_STATE_FILE;
  if (!stateFile) return undefined;
  if (!fs.existsSync(stateFile)) {
    throw new Error(`BUG1004949 runtime state is missing: ${stateFile}`);
  }
  return JSON.parse(fs.readFileSync(stateFile, "utf8")) as RuntimeState;
}

const runtimeState = readRuntimeState();
const runtimeToken = runtimeState?.url_token ?? process.env.UI_RUNTIME_URL_TOKEN;
const runtimeArticles = runtimeState?.custom_urls?.article_0029;

// run-suite creates this token exactly once and passes the same runtime-state
// file to setup, verification, and recovery Playwright processes.  Never use
// Date.now() here: module evaluation happens independently in every process.
if (process.env.UI_RUNTIME_STATE_FILE && runtimeArticles?.length !== 3) {
  throw new Error("BUG1004949 runtime state does not contain the complete article 0029 URL fixture");
}
if (!runtimeToken) {
  throw new Error("BUG1004949 runtime URL token is missing; run tests through npm run test:nonblocked, test:case, or test:group");
}

export const article0029Fixtures = (runtimeArticles ?? [
  { title: "article one", path: `/bug1004949/a1-${runtimeToken}.html` },
  { title: "Example article title", path: `/bug1004949/a2-${runtimeToken}.html` },
  { title: "article three", path: `/bug1004949/a3-${runtimeToken}.html` },
]) as ReadonlyArray<{ title: string; path: string }>;

export const protectedMessage = "The website you are visiting has password protection enabled, please enter the access password.";
export const employeeMessage = /Only employees are authorized to view this page\./i;
export const memberDeniedMessage = /Only (No level|VIP|members?) .*authorized to view this page/i;
