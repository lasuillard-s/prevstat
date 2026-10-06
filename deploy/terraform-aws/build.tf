locals {
  # Application source
  source_filename  = "source.zip"
  source_hash      = data.archive_file.source_zip.output_md5
  source_s3_prefix = "${local.source_hash}/"
  source_s3_key    = "${local.source_s3_prefix}${local.source_filename}"

  # Build artifact
  dist_filename  = "dist.zip"
  dist_s3_prefix = "${local.source_hash}/"
  dist_s3_key    = "${local.dist_s3_prefix}${local.dist_filename}"
}

module "codebuild_artifacts" {
  source  = "terraform-aws-modules/s3-bucket/aws"
  version = "~> 5.0"

  bucket_prefix = "${var.app_name}-codebuild-artifact-"
  force_destroy = true

  control_object_ownership = true
  object_ownership         = "BucketOwnerEnforced"

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

resource "aws_iam_role" "codebuild_role" {
  name = "${var.app_name}-codebuild-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action    = "sts:AssumeRole",
        Effect    = "Allow",
        Principal = { Service = "codebuild.amazonaws.com" }
      }
    ]
  })
}

# NOTE: `archive_file` datasource supports does not include pattern, so we have to
#       list all files we want to include in the zip file.
data "archive_file" "source_zip" {
  type        = "zip"
  output_path = "${path.module}/${local.source_filename}"

  dynamic "source" {
    for_each = setunion(
      fileset(local.project_root, "src/**"),
      [
        "app.yaml",
        "build.js",
        "package.json",
        "package-lock.json",
        "tsconfig.json",
      ]
    )

    content {
      content  = file("${local.project_root}/${source.value}")
      filename = source.value
    }
  }
}

resource "aws_s3_object" "source_zip" {
  bucket = module.codebuild_artifacts.s3_bucket_id
  key    = local.source_s3_key
  source = data.archive_file.source_zip.output_path
  etag   = filemd5(data.archive_file.source_zip.output_path)
}

resource "aws_iam_role_policy" "codebuild_policy" {
  name = "${var.app_name}-codebuild-policy"
  role = aws_iam_role.codebuild_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow",
        Action   = ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject", "s3:GetBucketLocation"],
        Resource = "${module.codebuild_artifacts.s3_bucket_arn}/*"
      },
      {
        Effect = "Allow",
        Action = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
        Resource = [
          aws_cloudwatch_log_group.build_logs.arn,
          "${aws_cloudwatch_log_group.build_logs.arn}:*"
        ]
      },
    ]
  })
}

resource "aws_cloudwatch_log_group" "build_logs" {
  name              = "/aws/codebuild/${var.app_name}-build"
  retention_in_days = 3
}

resource "aws_codebuild_project" "build" {
  name         = "${var.app_name}-build"
  description  = "Build project for ${var.app_name}"
  service_role = aws_iam_role.codebuild_role.arn

  build_timeout = 5 # In minutes

  source {
    type     = "S3"
    location = "${module.codebuild_artifacts.s3_bucket_id}/${local.source_s3_key}"
    buildspec = yamlencode({
      version = "0.2"
      phases = {
        install = {
          runtime-versions = {
            nodejs = 24
          }
          commands = [
            "npm ci"
          ]
        }
        build = {
          commands = [
            "npm run build",
            "cp package.json package-lock.json dist/",
            "(cd dist && npm ci --omit=dev && rm --force package.json package-lock.json)"
          ]
        }
      }
      artifacts = {
        files = ["dist/**/*"]
      }
    })
  }

  artifacts {
    type           = "S3"
    location       = module.codebuild_artifacts.s3_bucket_id
    path           = local.dist_s3_prefix
    namespace_type = "NONE" # Don't create a subdirectory for the build artifact in the S3 bucket
    packaging      = "ZIP"
    name           = local.dist_filename
  }

  environment {
    # NOTE: It takes about 1~2 minute (2026-09-03) to build the package and
    #       monthly free tier limit is 100 minutes (~50 builds).
    compute_type                = "BUILD_GENERAL1_SMALL"
    type                        = "LINUX_CONTAINER"
    image                       = "aws/codebuild/amazonlinux-x86_64-standard:6.0"
    image_pull_credentials_type = "CODEBUILD"
  }

  logs_config {
    cloudwatch_logs {
      status     = "ENABLED"
      group_name = aws_cloudwatch_log_group.build_logs.name
    }
  }
}

resource "terraform_data" "build_trigger" {
  depends_on = [aws_codebuild_project.build, aws_s3_object.source_zip]

  input = local.source_hash

  lifecycle {
    action_trigger {
      events  = [before_create, before_update]
      actions = [action.aws_codebuild_start_build.build]
    }
  }
}

action "aws_codebuild_start_build" "build" {
  config {
    project_name = aws_codebuild_project.build.name
    timeout      = "300" # 5 minutes
  }
}
