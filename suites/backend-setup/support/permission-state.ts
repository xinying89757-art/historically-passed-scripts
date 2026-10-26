export type AccessMode = "public" | "password" | "member" | "employee" | "form";

export type PagePermissionState = {
  mode: AccessMode;
  password?: string;
  memberLevel?: string;
  memberLevelLabel?: string;
  formName?: string;
  formNameLabel?: string;
};

function sameOption(
  currentValue: string | undefined,
  currentLabel: string | undefined,
  expectedValue: string | undefined,
  expectedLabel: string | undefined,
): boolean {
  if (expectedValue === undefined && expectedLabel === undefined) return false;
  return [currentValue, currentLabel]
    .filter((value): value is string => value !== undefined)
    .some((current) => [expectedValue, expectedLabel]
      .filter((value): value is string => value !== undefined)
      .some((expected) => current.trim() === expected.trim()));
}

export function permissionStateMatches(current: PagePermissionState, expected: PagePermissionState): boolean {
  if (current.mode !== expected.mode) return false;
  if (expected.mode === "password") {
    return expected.password !== undefined && current.password === expected.password;
  }
  if (expected.mode === "member") {
    const vipValue = expected.memberLevel === "VIP" || expected.memberLevelLabel === "VIP" ? "2" : undefined;
    return sameOption(
      current.memberLevel,
      current.memberLevelLabel,
      expected.memberLevel ?? vipValue,
      expected.memberLevelLabel ?? (vipValue ? "VIP" : undefined),
    );
  }
  if (expected.mode === "form") {
    return sameOption(current.formName, current.formNameLabel, expected.formName, expected.formNameLabel);
  }
  return true;
}

export function permissionMismatchReason(current: PagePermissionState, expected: PagePermissionState): string {
  if (current.mode !== expected.mode) return `access mode is ${current.mode}, expected ${expected.mode}`;
  if (expected.mode === "password") return "saved password does not match the configured test password";
  if (expected.mode === "member") return "saved member level does not match the configured member level";
  if (expected.mode === "form") return "saved form does not match the configured form";
  return "saved permission state does not match the requested state";
}
