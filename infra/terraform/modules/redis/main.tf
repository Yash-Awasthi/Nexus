# SPDX-License-Identifier: Apache-2.0
# modules/redis/main.tf — Upstash Redis database
#
# Manages an Upstash serverless Redis instance for BullMQ queues and caching.
# Upstash is the default Redis provider for Nexus (zero-ops, per-request billing).
#
# Usage:
#   module "redis" {
#     source      = "../../modules/redis"
#     name        = "nexus-staging"
#     region      = "us-east-1"
#   }

terraform {
  required_providers {
    upstash = {
      source  = "upstash/upstash"
      version = "~> 1.5"
    }
  }
}

resource "upstash_redis_database" "this" {
  database_name = var.name
  region        = var.region
  tls           = true
  eviction      = var.eviction_policy

  # Enable multi-zone replication for production environments
  multizone = var.multizone
}
