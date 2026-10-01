# SPDX-License-Identifier: Apache-2.0
variable "project_id" {
  description = "Google Cloud project ID"
  type        = string
}

variable "name" {
  description = "Cluster name"
  type        = string
  default     = "nexus"
}

variable "region" {
  description = "Region for the regional cluster"
  type        = string
  default     = "us-central1"
}

variable "release_channel" {
  description = "GKE release channel: RAPID, REGULAR or STABLE"
  type        = string
  default     = "REGULAR"
}

variable "machine_type" {
  description = "Node machine type"
  type        = string
  default     = "e2-standard-4"
}

variable "disk_size_gb" {
  description = "Node boot disk size"
  type        = number
  default     = 50
}

variable "min_nodes" {
  description = "Minimum nodes per zone"
  type        = number
  default     = 1
}

variable "max_nodes" {
  description = "Maximum nodes per zone"
  type        = number
  default     = 5
}

variable "deletion_protection" {
  description = "Refuse terraform destroy on the cluster"
  type        = bool
  default     = true
}
