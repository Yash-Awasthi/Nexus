# SPDX-License-Identifier: Apache-2.0
# modules/secrets/main.tf — Doppler secrets sync
#
# Manages Doppler project + config scoping for Nexus environments.
# Doppler is the secrets provider used by @nexus/adapters/doppler.
#
# The module creates:
#   - A Doppler project (if it doesn't already exist)
#   - A config per environment (dev, staging, production)
#   - Service tokens scoped per service (api, worker, ingest)
#
# Usage:
#   module "secrets" {
#     source       = "../../modules/secrets"
#     project_name = "nexus"
#     environment  = "staging"
#     services     = ["api", "worker", "ingest"]
#   }

terraform {
  required_providers {
    doppler = {
      source  = "DopplerHQ/doppler"
      version = "~> 1.4"
    }
  }
}

data "doppler_secrets" "env" {
  project = var.project_name
  config  = var.environment
}

# Service token per service — scoped read-only access
resource "doppler_service_token" "services" {
  for_each = toset(var.services)

  project = var.project_name
  config  = var.environment
  name    = "nexus-${each.key}-${var.environment}"
  access  = "read"
}
