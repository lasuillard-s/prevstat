import { getSignedCookies } from "@aws-sdk/cloudfront-signer";
import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../../src/config.js";
import { bakeCloudFrontCookies } from "../../../src/lib/aws/cloudfront.js";

vi.mock("@aws-sdk/cloudfront-signer", () => ({
  getSignedCookies: vi.fn().mockReturnValue({
    "CloudFront-Key-Pair-Id": "mock-key-pair-id",
    "CloudFront-Policy": "mock-policy",
    "CloudFront-Signature": "mock-signature",
  }),
}));

describe("bakeCloudFrontCookies", () => {
  const mockConfig: AppConfig = {
    GITHUB_CLIENT_ID: "client-id",
    GITHUB_CLIENT_SECRET: "client-secret",
    ALLOWED_PRINCIPALS: ["*"],
    CLOUDFRONT_DOMAIN: "assets.example.com",
    CLOUDFRONT_PRIVATE_KEY: "mock-private-key",
    CLOUDFRONT_KEY_PAIR_ID: "key-pair-id",
    CLOUDFRONT_SIGNED_COOKIE_EXPIRATION_SECONDS: 900,
    JWT_SECRET: "jwt-secret",
    JWT_EXPIRATION_SECONDS: 300,
    NONCE_COOKIE_EXPIRATION_SECONDS: 300,
    S3_BUCKET_NAME: "test-bucket",
    SQS_QUEUE_URL:
      "https://sqs.us-east-1.amazonaws.com/123456789012/test-queue",
    ARTIFACT_PATTERNS: [
      "my-org/my-repo:.github/workflows/ci.yaml:build-output*",
    ],
  };

  it("creates signed cookies with proper policy for leading slash path", () => {
    // Fixed timestamp corresponding to Wed Nov 15 2023 07:13:20 GMT+0900 (1700000000 epoch seconds)
    const expiresAt = new Date(1700000000000);
    const cookies = bakeCloudFrontCookies(
      "/private/owner/repo/*",
      expiresAt,
      mockConfig,
    );

    expect(cookies).toEqual({
      "CloudFront-Key-Pair-Id": "mock-key-pair-id",
      "CloudFront-Policy": "mock-policy",
      "CloudFront-Signature": "mock-signature",
    });

    expect(getSignedCookies).toHaveBeenCalledWith({
      keyPairId: "key-pair-id",
      privateKey: "mock-private-key",
      policy: JSON.stringify({
        Statement: [
          {
            Resource: "https://assets.example.com/private/owner/repo/*",
            Condition: {
              DateLessThan: {
                "AWS:EpochTime": 1700000000,
              },
            },
          },
        ],
      }),
    });
  });

  it("handles paths without leading slash", () => {
    // Fixed timestamp corresponding to Wed Nov 15 2023 07:13:20 GMT+0900 (1700000000 epoch seconds)
    const expiresAt = new Date(1700000000000);
    bakeCloudFrontCookies("private/owner/repo/*", expiresAt, mockConfig);

    expect(getSignedCookies).toHaveBeenCalledWith(
      expect.objectContaining({
        policy: expect.stringContaining(
          "https://assets.example.com/private/owner/repo/*",
        ),
      }),
    );
  });
});
