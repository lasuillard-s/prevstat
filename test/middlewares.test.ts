import type express from "express";
import type { Probot } from "probot";
import { beforeEach, describe, expect, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import {
  getAwsSource,
  notFoundMiddleware,
  originVerificationMiddleware,
} from "../src/middlewares.js";
import { test as it } from "./helpers.js";

const mockGetCurrentInvoke = vi.fn().mockReturnValue({});

vi.mock("@codegenie/serverless-express", () => ({
  getCurrentInvoke: () => mockGetCurrentInvoke(),
}));

describe("originVerificationMiddleware", () => {
  let mockConfig: AppConfig;

  beforeEach(() => {
    mockConfig = {
      GITHUB_CLIENT_ID: "client-id",
      GITHUB_CLIENT_SECRET: "client-secret",
      ALLOWED_PRINCIPALS: ["*"],
      CLOUDFRONT_DOMAIN: "assets.example.com",
      CLOUDFRONT_PRIVATE_KEY: "key",
      CLOUDFRONT_KEY_PAIR_ID: "key-pair-id",
      CLOUDFRONT_SIGNED_COOKIE_EXPIRATION_SECONDS: 900,
      ORIGIN_VERIFY_SECRET: "test-secret",
      JWT_SECRET: "jwt-secret",
      JWT_EXPIRATION_SECONDS: 300,
      S3_BUCKET_NAME: "test-bucket",
      SQS_QUEUE_URL:
        "https://sqs.us-east-1.amazonaws.com/123456789012/test-queue",
      ARTIFACT_PATTERNS: [
        "my-org/my-repo:.github/workflows/ci.yaml:build-output*",
      ],
    };
  });

  const createMockReqRes = (
    probot: Probot,
    path: string,
    host: string,
    originVerifyHeader?: string,
  ) => {
    const req = {
      path,
      host,
      header: vi.fn((headerName: string) => {
        if (headerName.toLowerCase() === "x-origin-verify")
          return originVerifyHeader;
        return undefined;
      }),
      app: {
        locals: {
          probot,
          config: mockConfig,
        },
      },
    } as unknown as express.Request;

    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    } as unknown as express.Response;

    const next = vi.fn() as express.NextFunction;

    return { req, res, next };
  };

  it("allows AWS internal requests if event is from SQS", ({ probot }) => {
    mockGetCurrentInvoke.mockReturnValue({
      event: {
        Records: [
          {
            eventSource: "aws:sqs",
          },
        ],
      },
    });
    const { req, res, next } = createMockReqRes(
      probot,
      "/aws/sqs",
      "sqs.amazonaws.com",
    );
    originVerificationMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("rejects /aws requests if event is not from SQS (e.g. spoofed host header over HTTP)", ({
    probot,
  }) => {
    mockGetCurrentInvoke.mockReturnValue({
      event: {
        requestContext: { http: { method: "POST" } },
      },
    });
    const { req, res, next } = createMockReqRes(
      probot,
      "/aws/sqs",
      "sqs.amazonaws.com",
    );
    originVerificationMiddleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ message: "Forbidden" });
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects /aws requests if getCurrentInvoke has no event", ({ probot }) => {
    mockGetCurrentInvoke.mockReturnValue({});
    const { req, res, next } = createMockReqRes(
      probot,
      "/aws/sqs",
      "sqs.amazonaws.com",
    );
    originVerificationMiddleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ message: "Forbidden" });
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects non-AWS requests if X-Origin-Verify does not match", ({
    probot,
  }) => {
    const { req, res, next } = createMockReqRes(
      probot,
      "/api/auth",
      "example.com",
      "wrong-secret",
    );
    originVerificationMiddleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ message: "Unauthorized" });
    expect(next).not.toHaveBeenCalled();
  });

  it("allows non-AWS requests if X-Origin-Verify matches", ({ probot }) => {
    const { req, res, next } = createMockReqRes(
      probot,
      "/api/auth",
      "example.com",
      "test-secret",
    );
    originVerificationMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("allows requests if ORIGIN_VERIFY_SECRET is not set", ({ probot }) => {
    mockConfig.ORIGIN_VERIFY_SECRET = undefined;
    const { req, res, next } = createMockReqRes(
      probot,
      "/api/auth",
      "example.com",
    );
    originVerificationMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe("getAwsSource", () => {
  it('returns "aws:sqs" when event contains SQS records', () => {
    const event = {
      Records: [{ eventSource: "aws:sqs", body: "{}" }],
    };
    expect(getAwsSource(event)).toBe("aws:sqs");
  });

  it('returns "aws:sqs" when event contains SQS records even if not the first record', () => {
    const event = {
      Records: [
        { eventSource: "other" },
        { eventSource: "aws:sqs", body: "{}" },
      ],
    };
    expect(getAwsSource(event)).toBe("aws:sqs");
  });

  it("returns null for non-SQS records or non-AWS events", () => {
    expect(getAwsSource(null)).toBeNull();
    expect(getAwsSource(undefined)).toBeNull();
    expect(getAwsSource("string")).toBeNull();
    expect(getAwsSource({})).toBeNull();
    expect(getAwsSource({ Records: [] })).toBeNull();
    expect(getAwsSource({ Records: [{ eventSource: "custom" }] })).toBeNull();
    expect(getAwsSource({ requestContext: { http: {} } })).toBeNull();
  });
});

describe("notFoundMiddleware", () => {
  it("returns 404 Not Found", ({ probot }) => {
    const req = {
      method: "GET",
      url: "/unknown",
      app: { locals: { probot } },
    } as unknown as express.Request;

    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    } as unknown as express.Response;

    notFoundMiddleware(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ message: "Not Found" });
  });
});
