import type { S3Client } from "@aws-sdk/client-s3";
import type { SQSClient } from "@aws-sdk/client-sqs";
import type { Probot } from "probot";
import type { AppConfig } from "../config.js";

declare global {
  namespace Express {
    interface Locals {
      probot: Probot;
      config: AppConfig;
      s3Client?: S3Client;
      sqsClient?: SQSClient;
    }
  }
}

declare module "express-serve-static-core" {
  interface Locals {
    probot: Probot;
    config: AppConfig;
    s3Client?: S3Client;
    sqsClient?: SQSClient;
  }
}
