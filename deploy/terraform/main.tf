terraform {
  required_providers {
    null = {
      source  = "hashicorp/null"
      version = "~> 3.0"
    }
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  default_tags {
    tags = {
      Project = "presta"
      Source = "https://github.com/lasuillard-s/presta.git"
    }
  }
}

locals {
  project_root = abspath("${path.module}/../../")
}

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

module "lambda_function" {
  depends_on = [null_resource.build]
  source     = "terraform-aws-modules/lambda/aws"
  version    = "~> 8.0"

  function_name         = var.app_name
  description           = "Main handler function of ${var.app_name} app."
  runtime               = "nodejs24.x"
  handler               = "lambda.handler"
  environment_variables = merge(var.variables, var.secret_variables)

  create_package = false
  local_existing_package = data.archive_file.dist.output_path
}
