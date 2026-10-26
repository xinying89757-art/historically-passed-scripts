import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

export async function launchProxyContext(config, overrides = {}) {
  await mkdir(config.paths.userDataDir, { recursive: true });
  const browserOptions = {
    headless: overrides.headed ? false : Boolean(config.browser.headless),
    locale: config.browser.locale,
    slowMo: config.browser.slowMo,
    viewport: config.browser.viewport,
    ...(config.proxy?.server ? { proxy: { server: config.proxy.server } } : {}),
    ...overrides
  };
  delete browserOptions.headed;
  const context = await chromium.launchPersistentContext(config.paths.userDataDir, {
    ...browserOptions,
    ...(config.browser.channel ? { channel: config.browser.channel } : {})
  });
  return context;
}

export async function getOrCreatePage(context) {
  const pages = context.pages();
  return pages[0] ?? context.newPage();
}

export async function newPage(context) {
  return context.newPage();
}
