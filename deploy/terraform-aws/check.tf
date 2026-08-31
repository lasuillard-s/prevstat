/*
Validate GitHub app / repository configuration through GitHub API

Since the official GitHub Terraform provider does not provide enough information
to validate the GitHub app configuration, we call the GitHub API directly using
the GitHub App Token and HTTP data sources to fetch the app information.
*/
locals {
  # Expected (from app.yaml)
  app_manifest    = yamldecode(file("${local.project_root}/app.yaml"))
  required_perms  = local.app_manifest.default_permissions
  required_events = local.app_manifest.default_events

  # Current (from GitHub API)
  app_info               = jsondecode(data.http.github_app.response_body)
  installed_repositories = jsondecode(data.http.github_app_installation.response_body).repositories[*].full_name
  missing_perms          = { for perm, access in local.required_perms : perm => access if !contains(keys(local.app_info.permissions), perm) || local.app_info.permissions[perm] != access }
  missing_events         = [for event in local.required_events : event if !contains(local.app_info.events, event)]
}

data "github_app_token" "app_token" {
  app_id          = var.app_id
  installation_id = var.app_installation_id
  pem_file        = var.private_key
}

/*
We use `/apps/{slug}` API instead of `/app` or `/app/installations/{installation_id}` API,
because the latter two APIs do not work with the token returned by `data.github_app_token.app_token.token`.

- https://docs.github.com/en/rest/apps/apps?apiVersion=2026-03-10#get-the-authenticated-app
- https://docs.github.com/en/rest/apps/apps?apiVersion=2026-03-10#get-an-installation-for-the-authenticated-app

To use the latter APIs, we would need to take additional user API tokens or personal access tokens,
which would require additional configuration and permissions.

Please feel free to suggest a better approach if you have one.
*/
data "http" "github_app" {
  # https://docs.github.com/en/rest/apps/apps?apiVersion=2026-03-10#get-an-app
  method = "GET"
  url    = "${var.github_api_base_url}/apps/${var.app_slug}"

  request_headers = {
    "Accept"               = "application/vnd.github+json"
    "Authorization"        = sensitive("Bearer ${data.github_app_token.app_token.token}")
    "X-GitHub-Api-Version" = "2026-03-10"
  }
}

# WARNING: We only fetch the first 100 repositories accessible to the app installation (no filtering supported).
#          If we need to support more than 100 repositories, we would need to implement pagination.
data "http" "github_app_installation" {
  # https://docs.github.com/en/rest/apps/installations?apiVersion=2026-03-10#list-repositories-accessible-to-the-app-installation
  method = "GET"
  url    = "${var.github_api_base_url}/installation/repositories?per_page=100"

  request_headers = {
    "Accept"               = "application/vnd.github+json"
    "Authorization"        = sensitive("Bearer ${data.github_app_token.app_token.token}")
    "X-GitHub-Api-Version" = "2026-03-10"
  }
}

check "app_information_accessible" {
  assert {
    condition     = data.http.github_app.status_code == 200 && data.http.github_app_installation.status_code == 200
    error_message = "Failed to fetch GitHub app information. Please check if the app configuration is valid."
  }
}

check "app_has_required_permissions" {
  assert {
    condition     = length(local.missing_perms) == 0
    error_message = "GitHub app permissions do not match the expected configuration. Missing permissions: ${jsonencode(local.missing_perms)}"
  }
}

check "app_listen_to_required_events" {
  assert {
    condition     = length(local.missing_events) == 0
    error_message = "GitHub app events do not match the expected configuration. Missing events: ${jsonencode(local.missing_events)}"
  }
}
