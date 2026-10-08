import { describe, expect, it } from "vitest";
import type { AppConfig } from "../../src/config.js";
import {
  buildArtifactPath,
  buildRepositoryBasePath,
  isValidDocumentUri,
} from "../../src/lib/url.js";

describe("buildRepositoryBasePath", () => {
  it("builds a repository-scoped base path", () => {
    expect(buildRepositoryBasePath("private", "owner", "repo")).toBe(
      "/private/owner/repo",
    );
  });

  it("safely encodes repository owner and repo components", () => {
    expect(buildRepositoryBasePath("private", "owner/name", "repo:name")).toBe(
      "/private/owner%2Fname/repo%3Aname",
    );
  });
});

describe("buildArtifactPath", () => {
  it("builds a full artifact file path with all required arguments", () => {
    expect(
      buildArtifactPath(
        "private",
        "owner",
        "repo",
        123,
        "artifact-name",
        "dir/index.html",
      ),
    ).toBe("/private/owner/repo/123/artifact-name/dir/index.html");
  });

  it("safely encodes components while preserving file path segments", () => {
    expect(
      buildArtifactPath(
        "private",
        "owner/name",
        "repo",
        123,
        "artifact/name",
        "../etc/passwd",
      ),
    ).toBe("/private/owner%2Fname/repo/123/artifact%2Fname/../etc/passwd");
  });
});

describe("isValidDocumentUri", () => {
  const mockConfig = {
    CLOUDFRONT_DOMAIN: "assets.example.com",
  } as AppConfig;

  it("returns true for valid CloudFront private document URIs", () => {
    expect(
      isValidDocumentUri(
        "https://assets.example.com/private/my-org/my-repo/123/build-output/index.html",
        mockConfig,
      ),
    ).toBe(true);
  });

  it("returns false for foreign domains", () => {
    expect(
      isValidDocumentUri(
        "https://attacker.com/private/my-org/my-repo/123/build-output/index.html",
        mockConfig,
      ),
    ).toBe(false);
  });

  it("returns false for non-private paths", () => {
    expect(
      isValidDocumentUri(
        "https://assets.example.com/public/my-org/my-repo/123/build-output/index.html",
        mockConfig,
      ),
    ).toBe(false);
    expect(
      isValidDocumentUri("https://assets.example.com/api/auth", mockConfig),
    ).toBe(false);
  });

  it("returns false for malformed URLs", () => {
    expect(isValidDocumentUri("not-a-url", mockConfig)).toBe(false);
  });
});
