terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

locals {
  app_js_path = "${path.module}/${var.app_js_relative_path}"
}

resource "cloudflare_workers_script" "app" {
  account_id = var.cloudflare_account_id

  script_name         = var.app_name
  compatibility_date  = "2026-07-23"
  compatibility_flags = ["nodejs_compat"]

  main_module    = "app.js"
  content_file   = local.app_js_path
  content_sha256 = filesha256(local.app_js_path)

  bindings = concat(
    [
      for name, value in var.secret_variables :
      {
        type = "secret_text"
        name = name
        text = value
      }
    ],
    [
      for name, value in var.variables :
      {
        name = name
        text = value
      }
    ],
  )

  observability = {
    enabled            = true
    head_sampling_rate = 1.0
    logs = {
      enabled            = true
      head_sampling_rate = 1.0
      invocation_logs    = true
      persist            = true
    }
    traces = {
      enabled            = false
      head_sampling_rate = 1.0
    }
  }
}

resource "cloudflare_workers_script_subdomain" "app" {
  account_id = var.cloudflare_account_id

  script_name      = cloudflare_workers_script.app.script_name
  enabled          = true
  previews_enabled = false
}
