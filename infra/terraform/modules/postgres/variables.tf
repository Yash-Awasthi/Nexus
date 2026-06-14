# SPDX-License-Identifier: Apache-2.0
variable "project_name" {
  description = "Neon project name (e.g. nexus-production)"
  type        = string
}

variable "environment" {
  description = "Branch name / environment label (main, staging, preview)"
  type        = string
  default     = "main"
}

variable "region_id" {
  description = "Neon region (aws-us-east-1, aws-eu-central-1, etc.)"
  type        = string
  default     = "aws-us-east-1"
}

variable "pg_version" {
  description = "PostgreSQL major version"
  type        = number
  default     = 16
}

variable "database_name" {
  description = "Database name inside the Neon project"
  type        = string
  default     = "nexus"
}

variable "database_owner" {
  description = "Postgres role that owns the database"
  type        = string
  default     = "nexus_app"
}

variable "quota_active_time_seconds" {
  description = "Monthly active compute time quota (seconds); 0 = unlimited"
  type        = number
  default     = 0
}

variable "quota_compute_time_seconds" {
  description = "Monthly compute time quota (seconds); 0 = unlimited"
  type        = number
  default     = 0
}
