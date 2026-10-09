import { LocalstackContainer } from "@testcontainers/localstack";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Probot, ProbotOctokit } from "probot";
import { test as baseTest } from "vitest";
import { setupProbotApp } from "../src/app.js";
import { AppConfig } from "../src/config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const privateKey = fs.readFileSync(
  path.join(__dirname, "fixtures/mock-cert.pem"),
  "utf-8",
);

export interface TestFixtures {
  probot: Probot;
  localstack: URL;
}

export const test = baseTest.extend<TestFixtures>({
  // eslint-disable-next-line no-empty-pattern
  probot: async ({}, use) => {
    const probot = new Probot({
      appId: 123,
      privateKey,
      // Disable request throttling and retries for testing
      Octokit: ProbotOctokit.defaults({
        retry: { enabled: false },
        throttle: { enabled: false },
      }),
    });
    const appFn = setupProbotApp(
      AppConfig.parse({
        GITHUB_CLIENT_ID: "client-id",
        GITHUB_CLIENT_SECRET: "client-secret",
        ALLOWED_PRINCIPALS: process.env.ALLOWED_PRINCIPALS ?? "*",
        CLOUDFRONT_DOMAIN: "assets.example.com",
        CLOUDFRONT_PRIVATE_KEY: "key",
        CLOUDFRONT_KEY_PAIR_ID: "key-pair-id",
        CLOUDFRONT_SIGNED_COOKIE_EXPIRATION_SECONDS: 900,
        JWT_SECRET: "jwt-secret",
        JWT_EXPIRATION_SECONDS: 300,
        S3_BUCKET_NAME: "test-bucket",
        SQS_QUEUE_URL:
          "https://sqs.us-east-1.amazonaws.com/123456789012/test-queue",
        ARTIFACT_PATTERNS:
          "my-org/my-repo:.github/workflows/ci.yaml:build-output*",
      }),
    );
    await probot.load(appFn);
    await use(probot);
  },
  localstack: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      // NOTE: LocalStack 4 enforces auth tokens, so we use LocalStack 3.x for testing to avoid authentication issues.
      const container = await new LocalstackContainer(
        "localstack/localstack:3.8.1",
      ).start();
      const endpoint = new URL(container.getConnectionUri());
      try {
        await use(endpoint);
      } finally {
        await container.stop();
      }
    },
    { scope: "worker" },
  ],
});
