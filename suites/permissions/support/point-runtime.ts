import fs from "node:fs";
import path from "node:path";
import { expect, type FrameLocator, type Locator, type Page } from "@playwright/test";

type Scope = Page | FrameLocator | Locator;
type LocatorSpec = { strategy: "css" | "xpath" | "role" | "label" | "placeholder" | "text" | "testid"; value: string; options?: Record<string, unknown> };
type PointContext = { contextBindingId?: string; stateId?: string; instance?: Record<string, string | number> & { index?: number; text?: string } };
type PointVariant = { variant_id?: string; context_binding_id?: string; context_binding_ids?: string[]; state_id?: string; frame_chain?: string[]; container?: LocatorSpec; locator: LocatorSpec; status: string; evidence?: unknown[]; semantic_signature?: Record<string, unknown> | null };
type LockedPoint = { point_key: string; resolved_variant?: PointVariant | null; resolved_variants?: PointVariant[] };
type RegistryLock = {
  schema_version: "ui-point-registry.lock.v3" | "ui-point-registry.lock.v4" | "ui-point-registry.lock.v5" | "ui-point-registry.lock.v6";
  run_id: string; project_id: string; environment: string; required_point_keys: string[];
  points: Record<string, LockedPoint>; validation: { ok: boolean; errors: Array<unknown> };
};

export class PointAcquisitionGapError extends Error {
  readonly code = "POINT_ACQUISITION_GAP";
  constructor(message: string, readonly pointKey: string, readonly context: PointContext) { super(message); }
}

export function loadRegistryLock(file = process.env.UI_REGISTRY_LOCK): RegistryLock {
  if (!file) throw new Error("UI_REGISTRY_LOCK is required");
  const lock = JSON.parse(fs.readFileSync(path.resolve(file), "utf8")) as RegistryLock;
  if (!["ui-point-registry.lock.v3", "ui-point-registry.lock.v4", "ui-point-registry.lock.v5", "ui-point-registry.lock.v6"].includes(lock.schema_version)) throw new Error(`Unsupported registry lock: ${lock.schema_version}`);
  if (lock.validation?.ok !== true) throw new Error("Registry lock validation failed");
  if (process.env.UI_PROJECT_ID && lock.project_id !== process.env.UI_PROJECT_ID) throw new Error(`Registry project mismatch: ${lock.project_id}`);
  if (process.env.UI_ENVIRONMENT && lock.environment !== process.env.UI_ENVIRONMENT) throw new Error(`Registry environment mismatch: ${lock.environment}`);
  return lock;
}

function interpolate(value: string, instance: PointContext["instance"] = {}): string {
  return value.replace(/\$\{([A-Za-z_][\w]*)\}/gu, (_, key: string) => {
    if (instance[key] === undefined) throw new Error(`Missing instance parameter: ${key}`);
    return String(instance[key]);
  });
}
function interpolateSpec(spec: LocatorSpec, instance: PointContext["instance"]): LocatorSpec {
  const options = Object.fromEntries(Object.entries(spec.options ?? {}).map(([key, value]) => [key, typeof value === "string" ? interpolate(value, instance) : value]));
  return { ...spec, value: interpolate(spec.value, instance), options };
}
function scopeFor(page: Page, frameChain: string[] = [], instance?: PointContext["instance"]): Scope {
  let scope: Scope = page;
  for (const frameSelector of frameChain) scope = (scope as Page | FrameLocator).frameLocator(interpolate(frameSelector, instance));
  return scope;
}
function locatorFrom(scope: Scope, raw: LocatorSpec, instance?: PointContext["instance"]): Locator {
  const spec = interpolateSpec(raw, instance); const options = spec.options ?? {};
  switch (spec.strategy) {
    case "role": return scope.getByRole(spec.value as never, options as never);
    case "label": return scope.getByLabel(spec.value, options as never);
    case "placeholder": return scope.getByPlaceholder(spec.value, options as never);
    case "text": return scope.getByText(spec.value, options as never);
    case "testid": return scope.getByTestId(spec.value);
    case "xpath": return scope.locator(`xpath=${spec.value}`);
    case "css": return scope.locator(spec.value);
  }
}
function variantsFor(point: LockedPoint): PointVariant[] { return point.resolved_variants?.length ? point.resolved_variants : point.resolved_variant ? [point.resolved_variant] : []; }
function bindingIds(variant: PointVariant): string[] { return [...new Set([...(variant.context_binding_ids ?? []), variant.context_binding_id].filter(Boolean) as string[])]; }

export function createPointRuntime(page: Page, lock = loadRegistryLock()) {
  function selectVariant(pointKey: string, context: PointContext = {}): PointVariant {
    const point = lock.points[pointKey];
    if (!point) throw new PointAcquisitionGapError(`Unknown point_key: ${pointKey}`, pointKey, context);
    let candidates = variantsFor(point).filter((variant) => variant.status === "verified" && (variant.evidence?.length ?? 0) > 0 && variant.semantic_signature);
    if (context.contextBindingId) { const binding = context.contextBindingId; candidates = candidates.filter((variant) => bindingIds(variant).includes(binding)); }
    else if (new Set(candidates.flatMap(bindingIds)).size > 1) throw new PointAcquisitionGapError(`Point ${pointKey} has multiple context bindings; contextBindingId is required`, pointKey, context);
    if (context.stateId) candidates = candidates.filter((variant) => !variant.state_id || variant.state_id === context.stateId);
    if (!candidates.length) throw new PointAcquisitionGapError(`No verified compatible variant for ${pointKey}`, pointKey, context);
    if (candidates.length > 1) throw new PointAcquisitionGapError(`Multiple verified variants remain for ${pointKey}; acquire a more specific context`, pointKey, context);
    return candidates[0];
  }
  function resolve(pointKey: string, context: PointContext = {}): Locator {
    const variant = selectVariant(pointKey, context); let scope = scopeFor(page, variant.frame_chain, context.instance);
    if (variant.container) scope = locatorFrom(scope, variant.container, context.instance);
    let target = locatorFrom(scope, variant.locator, context.instance);
    if (context.instance?.text) target = target.filter({ hasText: String(context.instance.text) });
    if (context.instance?.index !== undefined) target = target.nth(Number(context.instance.index));
    return target;
  }
  async function unique(pointKey: string, context: PointContext = {}): Promise<Locator> {
    const target = resolve(pointKey, context); const count = await target.count();
    if (count !== 1) throw new PointAcquisitionGapError(`Point ${pointKey} resolved to ${count} elements`, pointKey, context);
    return target;
  }
  const point = {
    locator: resolve, resolve: unique,
    click: async (key: string, context?: PointContext) => (await unique(key, context)).click(),
    fill: async (key: string, value: string, context?: PointContext) => (await unique(key, context)).fill(value),
    select: async (key: string, value: string, context?: PointContext) => (await unique(key, context)).selectOption(value),
  };
  function expectPoint(key: string, context?: PointContext) {
    return {
      visible: async () => expect(await unique(key, context)).toBeVisible(),
      text: async (value: string | RegExp) => expect(await unique(key, context)).toHaveText(value),
      enabled: async () => expect(await unique(key, context)).toBeEnabled(),
      disabled: async () => expect(await unique(key, context)).toBeDisabled(),
    };
  }
  function expectBuiltin(key: "page.url" | "page.origin" | "page.title", expected: string | RegExp) {
    if (key === "page.url") return expect(page).toHaveURL(expected);
    if (key === "page.origin") return expect(new URL(page.url()).origin).toBe(expected);
    return expect(page).toHaveTitle(expected);
  }
  return { point, expectPoint, expectBuiltin, registryRunId: lock.run_id };
}
