locals {
  # Avoid circular dependency between S3 object and CloudFront distribution
  error_403_s3_key = "public/403.html"
  error_403_rendered_content = templatefile("./custom-error-responses/403.html.tftpl", {
    "CLOUDFRONT_DOMAIN" : module.cdn.cloudfront_distribution_domain_name
  })
}

resource "random_password" "x_origin_verify" {
  length = 32
}

resource "aws_s3_object" "error_403" {
  bucket       = module.static_websites.s3_bucket_id
  key          = local.error_403_s3_key
  content      = local.error_403_rendered_content
  content_type = "text/html; charset=utf-8"
  source_hash  = filemd5("./custom-error-responses/403.html.tftpl")
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
      domain_name               = module.static_websites.s3_bucket_bucket_regional_domain_name
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
    minimum_protocol_version       = "TLSv1" # Default certificate only supports TLSv1 and above
  }
}
