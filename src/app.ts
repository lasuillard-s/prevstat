import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { SQSClient } from "@aws-sdk/client-sqs";
import serverlessExpress from "@codegenie/serverless-express";
import express from "express";
import {
  createNodeMiddleware,
  createProbot,
  Probot,
  type Context,
} from "probot";
import { AppConfig } from "./config.js";
import InstallationHandler from "./event-handlers/installation.js";
import WorkflowRunCompletedHandler from "./event-handlers/workflow_run.completed.js";
import {
  notFoundMiddleware,
  originVerificationMiddleware,
} from "./middlewares.js";
import { router as apiRouter } from "./routes/api/index.js";
import { router as awsRouter } from "./routes/aws/index.js";

/**
 * Creates the AWS Lambda handler for the application.
 * @returns AWS Lambda handler function for the application.
 */
export async function createLambdaHandler() {
  if (
    !process.env.LAMBDA_S3_CONFIG_BUCKET ||
    !process.env.LAMBDA_S3_CONFIG_KEY
  ) {
    throw new Error("Missing S3 configuration for Lambda environment.");
  }
  await initEnv(
    process.env.LAMBDA_S3_CONFIG_BUCKET,
    process.env.LAMBDA_S3_CONFIG_KEY,
  );

  const app = await createApp();

  // https://github.com/CodeGenieApp/serverless-express
  // @ts-expect-error Library not properly typed
  const handler = serverlessExpress({
    app,
    eventSourceRoutes: {
      AWS_SQS: "/aws/sqs",
    },
  });
  return handler;
}

/**
 * Load configuration from an S3 object and merge it into process.env.
 * @param s3Bucket The name of the S3 bucket containing the configuration file.
 * @param s3Key The key (path) to the configuration file within the S3 bucket.
 */
async function initEnv(s3Bucket: string, s3Key: string) {
  const s3Client = new S3Client({
    // See https://github.com/aws/aws-sdk-js-v3/issues/7136
    forcePathStyle: process.env.AWS_S3_USE_PATH_STYLE_ENDPOINT === "true",
  });
  try {
    const response = await s3Client.send(
      new GetObjectCommand({ Bucket: s3Bucket, Key: s3Key }),
    );
    const jsonStr = await response.Body?.transformToString();
    if (jsonStr) {
      const configObj = JSON.parse(jsonStr);
      process.env = { ...process.env, ...configObj };
    } else {
      console.debug("S3 object has no value.");
    }
    console.debug("Successfully retrieved S3 object:", s3Key);
  } catch (error) {
    throw new Error("Error retrieving S3 object", { cause: error });
  }
}

/**
 * Returns the Express app configured with the Probot middleware and custom routes.
 * @param config Optional application configuration
 * @param probot Optional Probot instance
 * @param setupProbot Optional Probot application setup function
 * @returns Express app
 */
export async function createApp(
  config?: AppConfig,
  probot?: Probot,
  setupProbot?: (probot: Probot) => void | Promise<void>,
): Promise<express.Express> {
  const app = express();
  probot ??= createProbot();
  if (!config) {
    try {
      config = AppConfig.parse(process.env);
    } catch (error) {
      throw new Error("Failed to load configuration", { cause: error });
    }
  }
  if (!setupProbot) {
    setupProbot = setupProbotApp(config, app.locals.sqsClient);
  }

  // Extend app locals context
  app.locals.probot = probot;
  app.locals.config = config;

  // Middleware
  app.use(originVerificationMiddleware);
  app.use(
    await createNodeMiddleware(setupProbot, {
      probot,
      webhooksPath: "/api/github/webhooks",
    }),
  );

  // Register routes
  app.use("/api", apiRouter);
  app.use("/aws", awsRouter);

  // Fallback
  app.use(notFoundMiddleware);

  return app;
}

/**
 * Creates the Probot app configuration function.
 * @param config Application configuration
 * @param sqsClient Optional SQS client instance
 * @returns App initialization function for Probot
 */
// BUG: This function is not imported and no need to be imported by any other module in the project,
//      but CI fails with import failure
export function setupProbotApp(config: AppConfig, sqsClient?: SQSClient) {
  return function (probot: Probot): void {
    probot.onError((error) => {
      probot.log.error(error, "Unhandled error caught");
    });

    // Register event listeners
    // NOTE: Lambda will freeze the process after the handler returns,
    //       so we need to await the handler to ensure it completes before returning.

    probot.on(
      ["installation.created", "installation.unsuspend"],
      async (
        context: Context<"installation.created" | "installation.unsuspend">,
      ) => {
        await new InstallationHandler(context, config, probot).execute();
      },
    );

    probot.on(
      "workflow_run.completed",
      async (context: Context<"workflow_run.completed">) => {
        await new WorkflowRunCompletedHandler(
          context,
          config,
          sqsClient,
        ).execute();
      },
    );

    probot.log.info("Probot middleware initialized");
  };
}
