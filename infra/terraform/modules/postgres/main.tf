# SPDX-License-Identifier: Apache-2.0
# modules/postgres/main.tf — Neon serverless Postgres instance
#
# Manages a Neon project + branch + database for a Nexus environment.
# Neon is the default DB adapter used by @nexus/adapters/neon.
#
# Usage:
#   module "postgres" {
#     source      = "../../modules/postgres"
#     environment = "staging"
#     project_name = "nexus-staging"
#   }

terraform {
  required_providers {
    neon = {
      source  = "kislerdm/neon"
      version = "~> 0.6"
    }
  }
}

resource "neon_project" "this" {
  name      = var.project_name
  region_id = var.region_id

  default_branch_name = "main"

  pg_version = var.pg_version

  quota {
    active_time_seconds  = var.quota_active_time_seconds
    compute_time_seconds = var.quota_compute_time_seconds
  }
}

resource "neon_branch" "env" {
  project_id = neon_project.this.id
  name       = var.environment
}

resource "neon_database" "nexus" {
  project_id = neon_project.this.id
  branch_id  = neon_branch.env.id
  name       = var.database_name
  owner_name = var.database_owner
}

resource "neon_role" "app" {
  project_id = neon_project.this.id
  branch_id  = neon_branch.env.id
  name       = var.database_owner
}
