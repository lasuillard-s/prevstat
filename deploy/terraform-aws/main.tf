locals {
  project_root = abspath("${path.module}/../../")

  /*
  Name for SSM parameter to store app config (variables and secrets)

  - Bypass Lambda environment variable size limit (4KB)
  - Avoid circular dependency between Lambda, SSM parameter and CloudFront distribution
  */
  lambda_app_config_name = "/${var.app_name}/config"

  # Avoid circular dependency between S3 object and CloudFront distribution
  error_403_s3_key = "public/403.html"
}

data "aws_partition" "current" {}
data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

resource "null_resource" "build" {
  triggers = {
    run_always = timestamp()
  }

  provisioner "local-exec" {
    working_dir = local.project_root
    command     = "npm run build"
  }
}

data "archive_file" "dist" {
  depends_on = [null_resource.build]

  type        = "zip"
  source_dir  = "${local.project_root}/dist"
  output_path = "${path.module}/dist.zip"
}

resource "random_password" "jwt_secret" {
  length = 32
}

resource "random_password" "x_origin_verify" {
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
      "S3_BUCKET_NAME" : module.s3_bucket.s3_bucket_id,
      "SQS_QUEUE_URL" : module.sqs.queue_url,
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
      module.sqs.queue_arn
    ]
  }

  statement {
    sid = "AllowLambdaToUploadArtifactsToS3"
    actions = [
      "s3:PutObject"
    ]
    resources = [
      "${module.s3_bucket.s3_bucket_arn}/*"
    ]
  }
}

# https://registry.terraform.io/modules/terraform-aws-modules/lambda/aws/latest
module "lambda_function" {
  depends_on = [null_resource.build]
  source     = "terraform-aws-modules/lambda/aws"
  version    = "~> 8.0"

  function_name = var.app_name
  description   = "Main handler function of ${var.app_name} app."

  runtime                 = "nodejs24.x"
  handler                 = "aws-lambda.handler"
  create_package          = false
  local_existing_package  = data.archive_file.dist.output_path
  ignore_source_code_hash = false

  attach_policy_json = true
  policy_json        = data.aws_iam_policy_document.lambda_function.json

  environment_variables = merge(
    {
      "LAMBDA_SSM_PARAMETER_NAME" : local.lambda_app_config_name,
    },
    var.variables, // User-provided variables will OVERRIDE
  )

  timeout = 30

  // Lambda function URL is not protected by IAM for now
  create_lambda_function_url = true

  cloudwatch_logs_retention_in_days = 1

  event_source_mapping = {
    sqs = {
      event_source_arn                   = module.sqs.queue_arn
      function_response_types            = ["ReportBatchItemFailures"]
      batch_size                         = 5
      maximum_batching_window_in_seconds = 10

      scaling_config = {
        maximum_concurrency = 3
      }
    }
  }
}

module "sqs" {
  source  = "terraform-aws-modules/sqs/aws"
  version = "~> 5.0"

  name = "${var.app_name}-queue"

  fifo_queue                 = false
  visibility_timeout_seconds = 180
}

data "aws_iam_policy_document" "for_cloudfront" {
  statement {
    actions = [
      "s3:GetObject",
      "s3:ListBucket" # Let CloudFront to respond with 404 for non-existing objects
    ]
    resources = [
      "${module.s3_bucket.s3_bucket_arn}",
      "${module.s3_bucket.s3_bucket_arn}/*"
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

module "s3_bucket" {
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
}

resource "aws_s3_object" "error_403" {
  bucket = module.s3_bucket.s3_bucket_id
  key    = local.error_403_s3_key
  content = templatefile("./custom-error-responses/403.html.tftpl", {
    "CLOUDFRONT_DOMAIN" : module.cdn.cloudfront_distribution_domain_name
  })
  content_type = "text/html; charset=utf-8"
  etag         = filemd5("./custom-error-responses/403.html.tftpl")
}

# https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-trusted-signers.html
# NOTE: ECDSA P-256 is supported, but not for SDK (our Lambda): https://github.com/aws/aws-sdk-js-v3/issues/7851
resource "tls_private_key" "private_key" {
  algorithm = "RSA"
  rsa_bits  = 2048
}

resource "aws_cloudfront_public_key" "public_key" {
  name        = "${var.app_name}-public-key"
  comment     = "Public key for ${var.app_name} app."
  encoded_key = tls_private_key.private_key.public_key_pem
}

resource "aws_cloudfront_key_group" "default" {
  name    = "${var.app_name}-key-group"
  comment = "Key group for ${var.app_name} app."
  items   = [aws_cloudfront_public_key.public_key.id]
}

# https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-cache-policies.html
# https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-origin-request-policies.html
module "cdn" {
  source  = "terraform-aws-modules/cloudfront/aws"
  version = "~> 6.0"

  aliases = []
  comment = "CloudFront distribution for ${var.app_name} app."

  origin = {
    s3_bucket = {
      domain_name               = module.s3_bucket.s3_bucket_bucket_regional_domain_name
      origin_access_control_key = "s3"
    }
    lambda_function = {
      # NOTE: Remove https:// prefix and trailing slash (/)
      domain_name = replace(replace(module.lambda_function.lambda_function_url, "https://", ""), "/", "")
      custom_origin_config = {
        http_port              = 80
        https_port             = 443
        origin_protocol_policy = "https-only"
        origin_ssl_protocols   = ["TLSv1.2"]
      }
      custom_header = {
        "X-Origin-Verify" : sensitive(random_password.x_origin_verify.result)
      }
    }
  }

  origin_access_control = {
    s3 = {
      description      = "CloudFront access to S3"
      origin_type      = "s3"
      signing_behavior = "always"
      signing_protocol = "sigv4"
    }
  }

  # Public documents (evaluated at last)
  default_cache_behavior = {
    target_origin_id       = "s3_bucket"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    viewer_protocol_policy = "redirect-to-https"
    cache_policy_name      = "Managed-CachingOptimized"
  }

  ordered_cache_behavior = [
    # API
    {
      path_pattern               = "/api/*"
      target_origin_id           = "lambda_function"
      allowed_methods            = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
      cached_methods             = ["GET", "HEAD"]
      cache_policy_name          = "Managed-CachingDisabled"
      origin_request_policy_name = "Managed-AllViewerExceptHostHeader"
      viewer_protocol_policy     = "redirect-to-https"
    },
    # Private documents
    {
      path_pattern           = "/private/*"
      target_origin_id       = "s3_bucket"
      allowed_methods        = ["GET", "HEAD"]
      cached_methods         = ["GET", "HEAD"]
      trusted_key_groups     = [aws_cloudfront_key_group.default.id]
      viewer_protocol_policy = "redirect-to-https"
      cache_policy_name      = "Managed-CachingOptimized"
    },
  ]

  custom_error_response = [
    # When user hit private document without signed cookie set, redirect to /api/auth
    {
      error_caching_min_ttl = 0
      error_code            = 403
      response_code         = 200
      response_page_path    = "/${local.error_403_s3_key}"
    }
  ]

  viewer_certificate = {
    cloudfront_default_certificate = true
  }
}
