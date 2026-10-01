# SPDX-License-Identifier: Apache-2.0
output "cluster_name" {
  description = "GKE cluster name"
  value       = google_container_cluster.this.name
}

output "endpoint" {
  description = "Kubernetes API endpoint"
  value       = google_container_cluster.this.endpoint
  sensitive   = true
}

output "ca_certificate" {
  description = "Cluster CA certificate (base64)"
  value       = google_container_cluster.this.master_auth[0].cluster_ca_certificate
  sensitive   = true
}
