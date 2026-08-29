import { describe, expect, it } from "vitest";
import { GITHUB_LOGIN_PATTERN, isValidLogin } from "./login";

describe("GITHUB_LOGIN_PATTERN", () => {
  it.each([
    ["a"],
    ["ab"],
    ["a-b"],
    ["a-b-c"],
    ["Mico"],
    ["M-i-c-o"],
    ["a1"],
    ["123"],
    ["a".repeat(39)],
    ["a-" + "b".repeat(37)],
  ])("accepts %s", (login) => {
    expect(GITHUB_LOGIN_PATTERN.test(login)).toBe(true);
  });

  it.each([
    [""],
    ["a".repeat(40)],
    ["-a"],
    ["a-"],
    ["a_b"],
    ["a b"],
    ["a/b"],
    ["a@b"],
    ["a\nb"],
    ["a".repeat(1000)],
  ])("rejects %s", (login) => {
    expect(GITHUB_LOGIN_PATTERN.test(login)).toBe(false);
  });

  it("accepts consecutive hyphens (documented pattern choice)", () => {
    // GitHub's own spec disallows consecutive hyphens; the pattern
    // above does NOT enforce that. This test pins the chosen
    // behavior so a future "fix" is a deliberate decision, not
    // an accidental tightening.
    expect(GITHUB_LOGIN_PATTERN.test("a--b")).toBe(true);
  });
});

describe("isValidLogin", () => {
  it("accepts every pattern-passing string", () => {
    expect(isValidLogin("Mico")).toBe(true);
    expect(isValidLogin("a")).toBe(true);
    expect(isValidLogin("a-1-b-2")).toBe(true);
  });

  it("is case-insensitive (case folded by the i flag)", () => {
    expect(isValidLogin("mico")).toBe(true);
    expect(isValidLogin("MICO")).toBe(true);
    expect(isValidLogin("Mico")).toBe(true);
  });

  it("rejects empty strings even though they'd fail the regex too", () => {
    expect(isValidLogin("")).toBe(false);
  });

  it("rejects null, undefined, numbers, objects, booleans, arrays", () => {
    expect(isValidLogin(null)).toBe(false);
    expect(isValidLogin(undefined)).toBe(false);
    expect(isValidLogin(42)).toBe(false);
    expect(isValidLogin({ login: "Mico" })).toBe(false);
    expect(isValidLogin(true)).toBe(false);
    expect(isValidLogin(false)).toBe(false);
    expect(isValidLogin(["Mico"])).toBe(false);
  });
});
