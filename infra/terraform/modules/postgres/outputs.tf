# SPDX-License-Identifier: Apache-2.0
output "project_id" {
  description = "Neon project ID"
  value       = neon_project.this.id
}

output "branch_id" {
  description = "Neon branch ID for this environment"
  value       = neon_branch.env.id
}

output "connection_uri" {
  description = "PostgreSQL connection URI (includes credentials — mark sensitive in consuming modules)"
  value       = "postgresql://${neon_role.app.name}:${neon_role.app.password}@${neon_project.this.database_host}/${neon_database.nexus.name}?sslmode=require"
  sensitive   = true
}

output "host" {
  description = "Neon database host"
  value       = neon_project.this.database_host
}
