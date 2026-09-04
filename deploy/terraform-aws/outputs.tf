output "cloudfront_domain" {
  value = module.cdn.cloudfront_distribution_domain_name
}

output "webhook_url" {
  value = "https://${module.cdn.cloudfront_distribution_domain_name}/api/github/webhooks"
}

output "redirect_uri" {
  value = "https://${module.cdn.cloudfront_distribution_domain_name}/api/auth/callback"
}
