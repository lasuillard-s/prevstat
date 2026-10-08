import { describe, expect, it } from "vitest";
import { errorToString, matchPatterns } from "../../src/utils/string.js";

describe("errorToString", () => {
  it("returns the message for Error instances", () => {
    expect(errorToString(new Error("boom"))).toBe("boom");
  });

  it("stringifies non-Error values", () => {
    expect(errorToString("plain failure")).toBe("plain failure");
    expect(errorToString(null)).toBe("null");
  });

  it("stringifies non-Error values", () => {
    expect(errorToString("plain failure")).toBe("plain failure");
    expect(errorToString(null)).toBe("null");
    expect(errorToString(undefined)).toBe("undefined");
    expect(errorToString(42)).toBe("42");
    expect(errorToString({ message: "nested" })).toBe("[object Object]");
  });
});

describe("matchPatterns", () => {
  it("matches values against glob patterns", () => {
    expect(matchPatterns("main", ["main", "develop"], {})).toBe(true);
    expect(matchPatterns("feature-branch", ["feature-*"], {})).toBe(true);
    expect(matchPatterns("hotfix-123", ["hotfix-*"], {})).toBe(true);
  });

  it("resolves aliases before matching", () => {
    const aliases = { "~DEFAULT_BRANCH": "main" };
    expect(matchPatterns("main", ["~DEFAULT_BRANCH"], aliases)).toBe(true);
    expect(matchPatterns("develop", ["~DEFAULT_BRANCH"], aliases)).toBe(false);
  });

  it("returns false for empty patterns array", () => {
    expect(matchPatterns("main", [], {})).toBe(false);
  });
});
