import { URL } from "node:url";

function asUrl(value) {
  if (!value) return null;
  try {
    return new URL(String(value));
  } catch {
    return null;
  }
}

function normalizePath(pagePath) {
  const value = String(pagePath ?? "").trim();
  if (!value) throw new Error("preview_unresolved: 页面路径为空");
  return value.startsWith("/") ? value : `/${value}`;
}

function previewOriginFromHost(host, protocol = "http:") {
  const value = String(host ?? "").trim().replace(/^https?:\/\//iu, "").split("/")[0];
  if (!value) return null;
  if (value.includes(".preview.leadong.com")) return `${protocol}//${value}`;
  if (/\.ldmfyh\.com$/iu.test(value)) {
    return `${protocol}//${value.replace(/\.ldmfyh\.com$/iu, ".preview.leadong.com")}`;
  }
  return null;
}

export function withCacheBust(url, token = Date.now()) {
  const parsed = asUrl(url);
  if (!parsed) throw new Error("preview_unresolved: 预览地址不是有效URL");
  parsed.searchParams.set("ge_run", String(token));
  return parsed.toString();
}

export function derivePreviewUrl(config, pagePath = config.targetPagePath) {
  const targetPath = normalizePath(pagePath);
  const resolution = config.previewResolution ?? {};
  const candidates = [
    { value: resolution.previewBaseUrl, source: "recorded" },
    { value: config.growthEngineSite?.host, source: "derived" },
    { value: config.publicBaseUrl, source: "derived" },
    { value: config.publicUrl, source: "legacy_recorded" },
  ];
  for (const candidate of candidates) {
    const parsed = asUrl(candidate.value);
    const protocol = parsed?.protocol ?? resolution.protocol ?? "http:";
    const origin = parsed
      ? previewOriginFromHost(parsed.hostname, protocol)
      : previewOriginFromHost(candidate.value, protocol);
    if (!origin) continue;
    const result = new URL(origin);
    result.pathname = targetPath;
    result.search = "";
    result.hash = "";
    const source = candidate.source === "legacy_recorded" && parsed?.hostname.includes(".preview.")
      ? "recorded"
      : candidate.source;
    return { url: result.toString(), source, host: result.hostname, pagePath: targetPath };
  }
  return { url: "", source: "unresolved", host: "", pagePath: targetPath };
}

export function resolvePreviewUrl(config, pagePath = config.targetPagePath, options = {}) {
  const targetPath = normalizePath(pagePath);
  const preferDerived = options.preferDerived ?? config.previewResolution?.preferDerived ?? false;
  const recorded = options.recordedPreviewUrl || config.previewResolution?.recordedPreviewUrl;
  if (!preferDerived && recorded) {
    const parsed = asUrl(recorded);
    if (parsed && parsed.pathname === targetPath && parsed.hostname.includes(".preview.")) {
      return { url: parsed.toString(), source: "recorded", host: parsed.hostname, pagePath: targetPath };
    }
  }
  const derived = derivePreviewUrl({
    ...config,
    previewResolution: {
      ...(config.previewResolution ?? {}),
      ...(recorded && !preferDerived ? { previewBaseUrl: recorded } : {}),
    },
  }, targetPath);
  if (derived.url) return derived;
  if (recorded) {
    const parsed = asUrl(recorded);
    if (parsed && parsed.pathname === targetPath) {
      return { url: parsed.toString(), source: "recorded", host: parsed.hostname, pagePath: targetPath };
    }
  }
  return { url: "", source: "unresolved", host: "", pagePath: targetPath };
}

export function assertPreviewPath(url, pagePath) {
  const parsed = asUrl(url);
  const expected = normalizePath(pagePath);
  if (!parsed) throw new Error("preview_unresolved: 预览地址不是有效URL");
  if (parsed.pathname !== expected) {
    throw new Error(`preview_unresolved: 预览地址路径 ${parsed.pathname} 与目标 ${expected} 不一致`);
  }
  return parsed.toString();
}
