locals {
  /*
  Name for SSM parameter to store app config (variables and secrets)

  - Bypass Lambda environment variable size limit (4KB)
  - Avoid circular dependency between Lambda, SSM parameter and CloudFront distribution
  */
  lambda_app_config_name = "/${var.app_name}/config"
}

resource "random_password" "jwt_secret" {
  length = 32
}

resource "aws_ssm_parameter" "lambda_app_config" {
  name = local.lambda_app_config_name
  type = "SecureString"
  value = jsonencode(merge(
    {
      // Probot
      "APP_ID" : var.app_id,
      "PRIVATE_KEY" : var.private_key,
      "WEBHOOK_SECRET" : var.webhook_secret,
      "GITHUB_CLIENT_ID" : var.github_client_id,
      "GITHUB_CLIENT_SECRET" : var.github_client_secret,
      // App
      "CLOUDFRONT_DOMAIN" : module.cdn.cloudfront_distribution_domain_name,
      "CLOUDFRONT_PRIVATE_KEY" : tls_private_key.private_key.private_key_pem,
      "CLOUDFRONT_KEY_PAIR_ID" : aws_cloudfront_public_key.public_key.id,
      "JWT_SECRET" : random_password.jwt_secret.result,
      "S3_BUCKET_NAME" : module.static_websites.s3_bucket_id,
      "SQS_QUEUE_URL" : module.task_queue.queue_url,
      "ORIGIN_VERIFY_SECRET" : random_password.x_origin_verify.result,
      "ARTIFACT_PATTERNS" : var.artifact_patterns
    },
    var.secret_variables // User-provided secrets will OVERRIDE
  ))
}

data "aws_iam_policy_document" "lambda_function" {
  statement {
    sid = "AllowLambdaToReadSSMParameter"
    actions = [
      "ssm:GetParameter"
    ]
    resources = [
      // NOTE: Using ARN instead of directly referencing aws_ssm_parameter.lambda_app_config.id
      // to avoid circular dependency issue with Lambda function
      "arn:${data.aws_partition.current.partition}:ssm:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:parameter${local.lambda_app_config_name}"
    ]
  }

  statement {
    sid = "AllowLambdaToDecryptSSMParameter"
    actions = [
      "kms:Decrypt"
    ]
    resources = [
      "arn:${data.aws_partition.current.partition}:kms:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:alias/aws/ssm"
    ]
  }

  statement {
    sid = "AllowLambdaToProcessSQSMessage"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      "sqs:SendMessage"
    ]
    resources = [
      module.task_queue.queue_arn
    ]
  }

  statement {
    sid = "AllowLambdaToUploadArtifactsToS3"
    actions = [
      "s3:PutObject"
    ]
    resources = [
      "${module.static_websites.s3_bucket_arn}/*"
    ]
  }
}

data "aws_s3_object" "build_artifact" {
  depends_on = [terraform_data.build_trigger]

  bucket = module.codebuild_artifacts.s3_bucket_id
  key    = local.artifacts_s3_key
}

# https://registry.terraform.io/modules/terraform-aws-modules/lambda/aws/latest
module "lambda_function" {
  depends_on = [data.aws_s3_object.build_artifact]

  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.0"

  function_name = var.app_name
  description   = "Main handler function of ${var.app_name} app."

  runtime = "nodejs24.x"
  handler = "dist/aws-lambda.handler"

  create_package = false
  s3_existing_package = {
    bucket     = data.aws_s3_object.build_artifact.bucket
    key        = data.aws_s3_object.build_artifact.key
    version_id = data.aws_s3_object.build_artifact.version_id
  }

  attach_policy_json = true
  policy_json        = data.aws_iam_policy_document.lambda_function.json

  environment_variables = merge(
    {
      "LAMBDA_SSM_PARAMETER_NAME" : local.lambda_app_config_name,
    },
    var.variables, // User-provided variables will OVERRIDE
  )

  timeout = 60

  // Lambda function URL is not protected by IAM for now
  create_lambda_function_url = true

  cloudwatch_logs_retention_in_days = 1

  event_source_mapping = {
    sqs = {
      event_source_arn                   = module.task_queue.queue_arn
      function_response_types            = ["ReportBatchItemFailures"]
      batch_size                         = 5
      maximum_batching_window_in_seconds = 10

      scaling_config = {
        maximum_concurrency = 3
      }
    }
  }
}

module "task_queue" {
  source  = "terraform-aws-modules/sqs/aws"
  version = "~> 5.0"

  name = "${var.app_name}-queue"

  fifo_queue                 = false
  visibility_timeout_seconds = 300 # 5x of Lambda timeout
}

data "aws_iam_policy_document" "for_cloudfront" {
  statement {
    actions = [
      "s3:GetObject",
      "s3:ListBucket" # Let CloudFront to respond with 404 for non-existing objects
    ]
    resources = [
      "${module.static_websites.s3_bucket_arn}",
      "${module.static_websites.s3_bucket_arn}/*"
    ]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [module.cdn.cloudfront_distribution_arn]
    }
  }
}

module "static_websites" {
  source  = "terraform-aws-modules/s3-bucket/aws"
  version = "~> 5.0"

  bucket_prefix = "${var.app_name}-"
  force_destroy = true

  control_object_ownership = true
  object_ownership         = "BucketOwnerEnforced"

  attach_policy = true
  policy        = data.aws_iam_policy_document.for_cloudfront.json

  versioning = {
    enabled = false
  }

  lifecycle_rule = [
    {
      id      = "delete-objects-after-7-days"
      enabled = true

      expiration = {
        days = 7
      }
    }
  ]
}
