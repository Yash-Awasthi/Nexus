# SPDX-License-Identifier: Apache-2.0
variable "project_name" {
  description = "Doppler project name"
  type        = string
  default     = "nexus"
}

variable "environment" {
  description = "Doppler config/environment (dev, staging, production)"
  type        = string
}

variable "services" {
  description = "List of service names to generate scoped tokens for"
  type        = list(string)
  default     = ["api", "worker", "ingest"]
}
