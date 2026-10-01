# SPDX-License-Identifier: Apache-2.0
variable "name" {
  description = "Cluster name (also prefixes the IAM roles)"
  type        = string
  default     = "nexus"
}

variable "subnet_ids" {
  description = "Subnets for the cluster and nodes (at least two availability zones)"
  type        = list(string)
}

variable "kubernetes_version" {
  description = "EKS Kubernetes version"
  type        = string
  default     = "1.33"
}

variable "public_endpoint" {
  description = "Expose the Kubernetes API publicly"
  type        = bool
  default     = true
}

variable "instance_type" {
  description = "Node instance type"
  type        = string
  default     = "t3.large"
}

variable "disk_size_gb" {
  description = "Node disk size"
  type        = number
  default     = 50
}

variable "min_nodes" {
  description = "Minimum (and initial) node count"
  type        = number
  default     = 2
}

variable "max_nodes" {
  description = "Maximum node count"
  type        = number
  default     = 6
}
