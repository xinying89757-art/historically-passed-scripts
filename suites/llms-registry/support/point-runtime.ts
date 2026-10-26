import fs from "node:fs";
import path from "node:path";
import { expect, type FrameLocator, type Locator, type Page } from "@playwright/test";

type Scope = Page | FrameLocator;
type LocatorSpec = {
  strategy: "css" | "xpath" | "role" | "label" | "placeholder" | "text" | "testid";
  value: string;
  options?: Record<string, unknown>;
};
type PointVariant = { frame_chain?: string[]; locator: LocatorSpec; status: string };
type LockedPoint = { point_key: string; resolved_variant: PointVariant | null };
type RegistryLock = {
  schema_version: "ui-point-registry.lock.v2";
  run_id: string;
  project_id: string;
  environment: string;
  required_point_keys: string[];
  points: Record<string, LockedPoint>;
  validation: { ok: boolean; errors: Array<unknown> };
};

export function loadRegistryLock(file = process.env.UI_REGISTRY_LOCK): RegistryLock {
  if (!file) throw new Error("UI_REGISTRY_LOCK is required");
  const lock = JSON.parse(fs.readFileSync(path.resolve(file), "utf8")) as RegistryLock;
  if (lock.schema_version !== "ui-point-registry.lock.v2") throw new Error(`Unsupported registry lock: ${lock.schema_version}`);
  if (lock.validation?.ok !== true) throw new Error("Registry lock validation failed");
  if (process.env.UI_PROJECT_ID && lock.project_id !== process.env.UI_PROJECT_ID) throw new Error(`Registry project mismatch: ${lock.project_id}`);
  if (process.env.UI_ENVIRONMENT && lock.environment !== process.env.UI_ENVIRONMENT) throw new Error(`Registry environment mismatch: ${lock.environment}`);
  return lock;
}

function scopeFor(page: Page, frameChain: string[] = []): Scope {
  let scope: Scope = page;
  for (const frameSelector of frameChain) scope = scope.frameLocator(frameSelector);
  return scope;
}

function locatorFrom(scope: Scope, spec: LocatorSpec): Locator {
  const options = spec.options ?? {};
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

export function createPointRuntime(page: Page, lock = loadRegistryLock()) {
  function resolve(pointKey: string): Locator {
    const point = lock.points[pointKey];
    const variant = point?.resolved_variant;
    if (!point || !variant?.locator) throw new Error(`Unresolved point_key: ${pointKey}`);
    if (variant.status !== "verified") throw new Error(`Point is not verified: ${pointKey}`);
    return locatorFrom(scopeFor(page, variant.frame_chain), variant.locator);
  }

  const point = {
    locator: resolve,
    click: (key: string) => resolve(key).click(),
    fill: (key: string, value: string) => resolve(key).fill(value),
    select: (key: string, value: string) => resolve(key).selectOption(value),
  };

  function expectPoint(key: string) {
    const target = resolve(key);
    return {
      visible: () => expect(target).toBeVisible(),
      text: (value: string | RegExp) => expect(target).toHaveText(value),
      enabled: () => expect(target).toBeEnabled(),
      disabled: () => expect(target).toBeDisabled(),
    };
  }

  return { point, expectPoint, registryRunId: lock.run_id };
}
