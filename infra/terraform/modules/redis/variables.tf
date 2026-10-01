# SPDX-License-Identifier: Apache-2.0
variable "name" {
  description = "Upstash Redis database name"
  type        = string
}

variable "region" {
  description = "Upstash region (us-east-1, eu-west-1, ap-southeast-1, etc.)"
  type        = string
  default     = "us-east-1"
}

variable "eviction_policy" {
  description = "Redis eviction policy (noeviction, allkeys-lru, volatile-lru, etc.)"
  type        = string
  default     = "noeviction"
}

variable "multizone" {
  description = "Enable multi-zone replication (recommended for production)"
  type        = bool
  default     = false
}
