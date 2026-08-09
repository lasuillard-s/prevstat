variable "app_name" {
  type        = string
  description = "Application name"
  default     = "presta"
}

variable "app_id" {
  type        = string
  description = "The ID of your GitHub App (`APP_ID`)."
}

variable "private_key" {
  type        = string
  sensitive   = true
  description = "The private key of your GitHub App (`PRIVATE_KEY`)."
}

variable "webhook_secret" {
  type        = string
  sensitive   = true
  description = "The webhook secret of your GitHub App (`WEBHOOK_SECRET`)."
}

variable "github_client_id" {
  type        = string
  sensitive   = true
  description = "The client ID of your GitHub App (`GITHUB_CLIENT_ID`)."
}

variable "github_client_secret" {
  type        = string
  sensitive   = true
  description = "The client secret of your GitHub App (`GITHUB_CLIENT_SECRET`)."
}

variable "secret_variables" {
  type        = map(string)
  sensitive   = true
  description = "Additional secret variables for the application"
  default     = {}
}

variable "variables" {
  type        = map(string)
  description = "Additional variables for the application"
  default = {
    "LOG_LEVEL" = "info"
  }
}
