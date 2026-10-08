import { describe, expect, it } from "vitest";
import { sanitizeZipEntryPath } from "../../src/utils/zip.js";

describe("sanitizeZipEntryPath", () => {
  it("preserves valid relative paths and normalizes backslashes and leading slashes", () => {
    expect(sanitizeZipEntryPath("index.html")).toBe("index.html");
    expect(sanitizeZipEntryPath("assets/main.css")).toBe("assets/main.css");
    expect(sanitizeZipEntryPath("nested/dir/app.js")).toBe("nested/dir/app.js");
    expect(sanitizeZipEntryPath("assets\\style.css")).toBe("assets/style.css");
    expect(sanitizeZipEntryPath("/index.html")).toBe("index.html");
    expect(sanitizeZipEntryPath("///assets/style.css")).toBe(
      "assets/style.css",
    );
    expect(sanitizeZipEntryPath("./assets/./style.css")).toBe(
      "assets/style.css",
    );
  });

  it("returns null for path traversal or invalid paths", () => {
    expect(sanitizeZipEntryPath("..")).toBeNull();
    expect(sanitizeZipEntryPath("../index.html")).toBeNull();
    expect(sanitizeZipEntryPath("../../etc/passwd")).toBeNull();
    expect(sanitizeZipEntryPath("nested/../../etc/passwd")).toBeNull();
    expect(sanitizeZipEntryPath(".")).toBeNull();
    expect(sanitizeZipEntryPath("")).toBeNull();
    expect(sanitizeZipEntryPath("///")).toBeNull();
  });
});
