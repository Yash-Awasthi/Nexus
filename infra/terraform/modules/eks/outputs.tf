# SPDX-License-Identifier: Apache-2.0
output "cluster_name" {
  description = "EKS cluster name"
  value       = aws_eks_cluster.this.name
}

output "endpoint" {
  description = "Kubernetes API endpoint"
  value       = aws_eks_cluster.this.endpoint
}

output "ca_certificate" {
  description = "Cluster CA certificate (base64)"
  value       = aws_eks_cluster.this.certificate_authority[0].data
  sensitive   = true
}
