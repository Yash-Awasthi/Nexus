# SPDX-License-Identifier: Apache-2.0
output "database_id" {
  description = "Upstash Redis database ID"
  value       = upstash_redis_database.this.database_id
}

output "endpoint" {
  description = "Redis endpoint (host:port)"
  value       = "${upstash_redis_database.this.endpoint}:${upstash_redis_database.this.port}"
}

output "redis_url" {
  description = "Full Redis URL with credentials for REDIS_URL env var"
  value       = "rediss://:${upstash_redis_database.this.password}@${upstash_redis_database.this.endpoint}:${upstash_redis_database.this.port}"
  sensitive   = true
}

output "password" {
  description = "Redis auth token"
  value       = upstash_redis_database.this.password
  sensitive   = true
}
