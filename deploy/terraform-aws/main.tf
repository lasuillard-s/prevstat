locals {
  project_root_relative = "../../"
  project_root          = abspath("${path.module}/${local.project_root_relative}")
}

data "aws_partition" "current" {}
data "aws_region" "current" {}
data "aws_caller_identity" "current" {}
