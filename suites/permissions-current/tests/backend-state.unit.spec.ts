import { expect, test } from "@playwright/test";
import { permissionMismatchReason, permissionStateMatches } from "../support/permission-state.js";

test("password state compares the password as well as the access mode", () => {
  expect(permissionStateMatches(
    { mode: "password", password: "existing7" },
    { mode: "password", password: "target" },
  )).toBe(false);
  expect(permissionStateMatches(
    { mode: "password", password: "target" },
    { mode: "password", password: "target" },
  )).toBe(true);
});

test("password mismatch diagnostics never expose either password", () => {
  const reason = permissionMismatchReason(
    { mode: "password", password: "existing7" },
    { mode: "password", password: "target" },
  );
  expect(reason).toContain("password");
  expect(reason).not.toContain("existing7");
  expect(reason).not.toContain("target");
});

test("member and form states compare their selected configuration", () => {
  expect(permissionStateMatches(
    { mode: "member", memberLevel: "2", memberLevelLabel: "VIP" },
    { mode: "member", memberLevelLabel: "VIP" },
  )).toBe(true);
  expect(permissionStateMatches(
    { mode: "member", memberLevelLabel: "No level" },
    { mode: "member", memberLevelLabel: "VIP" },
  )).toBe(false);
  expect(permissionStateMatches(
    { mode: "form", formName: "contact-id", formNameLabel: "Contact Us" },
    { mode: "form", formNameLabel: "Contact Us" },
  )).toBe(true);
});

test("public and employee states require only the correct mode", () => {
  expect(permissionStateMatches({ mode: "public" }, { mode: "public" })).toBe(true);
  expect(permissionStateMatches({ mode: "employee" }, { mode: "employee" })).toBe(true);
  expect(permissionStateMatches({ mode: "public" }, { mode: "employee" })).toBe(false);
});
