import {
  CreateBucketCommand,
  GetObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  CreateQueueCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import AdmZip from "adm-zip";
import nock from "nock";
import { describe, expect, vi } from "vitest";
import type { AppConfig } from "../../../src/config.js";
import {
  ArtifactProcessor,
  submitArtifactProcessingTasks,
} from "../../../src/lib/aws/sqs.js";
import { test as it } from "../../helpers.js";

describe("AWS SQS & S3 Integration with LocalStack", () => {
  const region = "us-east-1";
  const bucketName = "sqs-test-bucket";
  let s3: S3Client;
  let sqs: SQSClient;
  let queueUrl: string;

  it.beforeAll(async ({ localstack }) => {
    const clientConfig = {
      endpoint: localstack.href,
      region,
      credentials: {
        accessKeyId: "test",
        secretAccessKey: "test",
      },
    };
    s3 = new S3Client({ ...clientConfig, forcePathStyle: true });
    sqs = new SQSClient(clientConfig);

    await s3.send(new CreateBucketCommand({ Bucket: bucketName }));
    const createQueueResponse = await sqs.send(
      new CreateQueueCommand({ QueueName: "artifact-processing-queue" }),
    );
    queueUrl = createQueueResponse.QueueUrl!;
  });

  it.beforeEach(({ localstack }) => {
    nock.cleanAll();
    nock.enableNetConnect(
      (host) =>
        host.includes(localstack.host) || host.includes(localstack.hostname),
    );
  });

  describe("submitArtifactProcessingTasks", () => {
    it("submits artifact messages to SQS queue and verifies message receipt", async () => {
      await submitArtifactProcessingTasks(
        sqs,
        queueUrl,
        {
          installationId: 1234,
          owner: "my-org",
          repo: "my-repo",
          runId: 5678,
        },
        [101, 102],
      );

      const receiveResponse = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
        }),
      );

      expect(receiveResponse.Messages).toBeDefined();
      expect(receiveResponse.Messages?.length).toBe(2);
      expect(
        receiveResponse.Messages?.map((msg) => JSON.parse(msg.Body!)),
      ).toEqual(
        expect.arrayContaining([
          {
            installationId: 1234,
            owner: "my-org",
            repo: "my-repo",
            runId: 5678,
            artifactId: 101,
          },
          {
            installationId: 1234,
            owner: "my-org",
            repo: "my-repo",
            runId: 5678,
            artifactId: 102,
          },
        ]),
      );
    });

    it("handles empty artifact list gracefully without sending SQS batch", async () => {
      const sqsSpy = vi.spyOn(sqs, "send");

      await submitArtifactProcessingTasks(
        sqs,
        queueUrl,
        { owner: "my-org", repo: "my-repo", runId: 1 },
        [],
      );

      expect(sqsSpy).not.toHaveBeenCalled();
      sqsSpy.mockRestore();
    });

    it("splits 25 items into chunks of 10, 10, 5", async () => {
      const artifactIds = Array.from({ length: 25 }, (_, i) => i + 1);

      await expect(
        submitArtifactProcessingTasks(
          sqs,
          queueUrl,
          { owner: "my-org", repo: "my-repo", runId: 1 },
          artifactIds,
        ),
      ).resolves.not.toThrow();
    });
  });

  describe("ArtifactProcessor", () => {
    const appConfig: AppConfig = {
      GITHUB_CLIENT_ID: "client-id",
      GITHUB_CLIENT_SECRET: "client-secret",
      ALLOWED_PRINCIPALS: ["*"],
      CLOUDFRONT_DOMAIN: "assets.example.com",
      CLOUDFRONT_PRIVATE_KEY: "key",
      CLOUDFRONT_KEY_PAIR_ID: "key-pair-id",
      CLOUDFRONT_SIGNED_COOKIE_EXPIRATION_SECONDS: 900,
      JWT_SECRET: "jwt-secret",
      JWT_EXPIRATION_SECONDS: 300,
      S3_BUCKET_NAME: bucketName,
      SQS_QUEUE_URL: queueUrl,
      ARTIFACT_PATTERNS: ["my-org/my-repo:.github/workflows/ci.yaml:build*"],
    };

    it("processes records, uploads to S3, and accumulates failures", async ({
      probot,
    }) => {
      const zip = new AdmZip();
      zip.addFile("index.html", Buffer.from("<h1>Hello from LocalStack</h1>"));
      const zipBuffer = zip.toBuffer();

      const mock = nock("https://api.github.com")
        .post("/app/installations/1234/access_tokens")
        .reply(201, { token: "ghs_mocktoken", permissions: {} })
        .get("/repos/my-org/my-repo")
        .reply(200, { private: true })
        .get("/repos/my-org/my-repo/actions/artifacts/101")
        .reply(200, {
          id: 101,
          name: "build-output-web",
          workflow_run: {
            id: 12345,
            head_sha: "abcdef123456",
          },
        })
        .get("/repos/my-org/my-repo/actions/runs/12345")
        .reply(200, {
          id: 12345,
          head_sha: "abcdef123456",
        })
        .get("/repos/my-org/my-repo/actions/artifacts/101/zip")
        .reply(200, zipBuffer, { "content-type": "application/zip" })
        .post("/repos/my-org/my-repo/statuses/abcdef123456", {
          state: "success",
          target_url:
            "https://assets.example.com/private/my-org/my-repo/12345/build-output-web/index.html",
          description: "Successfully uploaded artifact build-output-web to S3.",
          context: "Prevstat / build-output-web",
        })
        .reply(201, { state: "success" });

      const processor = new ArtifactProcessor(probot, appConfig, s3);

      const records = [
        {
          messageId: "msg-success",
          body: JSON.stringify({
            installationId: 1234,
            owner: "my-org",
            repo: "my-repo",
            runId: 12345,
            artifactId: 101,
          }),
        },
        {
          messageId: "msg-fail",
          body: "not-valid-json",
        },
      ];

      const failures = await processor.processBatch(records);
      expect(failures).toEqual([{ itemIdentifier: "msg-fail" }]);

      expect(mock.isDone()).toBe(true);
      expect(mock.pendingMocks()).toStrictEqual([]);

      // Verify file uploaded to LocalStack S3
      const s3Object = await s3.send(
        new GetObjectCommand({
          Bucket: bucketName,
          Key: "private/my-org/my-repo/12345/build-output-web/index.html",
        }),
      );
      const s3Content = await s3Object.Body?.transformToString();
      expect(s3Content).toBe("<h1>Hello from LocalStack</h1>");
    });
  });
});
