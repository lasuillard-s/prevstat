variable "cloudflare_api_token" {
  type        = string
  sensitive   = true
  description = "Cloudflare API token"
}

variable "cloudflare_account_id" {
  type        = string
  description = "Cloudflare account ID"
}

variable "app_name" {
  type        = string
  description = "Application name"
  default     = "presta"
}

variable "app_js_relative_path" {
  type        = string
  description = "Relative path to built app.js file, relative from current module directory"
  default     = "../../dist/app.js"
}

variable "variables" {
  type        = map(string)
  description = "Variables for the application"
  default     = {}
}

variable "secret_variables" {
  type        = map(string)
  sensitive   = true
  description = "Secret variables for the application"
  default     = {}

  validation {
    condition = alltrue(
      [
        for k in ["APP_ID", "PRIVATE_KEY", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "WEBHOOK_SECRET"]
        : contains(keys(var.secret_variables), k)
      ]
    )
    error_message = "secret_variables must contain the following keys: APP_ID, PRIVATE_KEY, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, WEBHOOK_SECRET"
  }
}
