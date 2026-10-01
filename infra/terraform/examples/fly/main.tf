# SPDX-License-Identifier: Apache-2.0
# NEXUS deployment on Fly.io
# Prerequisites: flyctl installed + authenticated; Fly.io account

terraform {
  required_version = ">= 1.7"
  required_providers {
    fly = {
      source  = "fly-apps/fly"
      version = "~> 0.0.23"
    }
  }
}

provider "fly" {
  # Uses FLY_API_TOKEN env var
}

variable "nexus_api_key" {
  type      = string
  sensitive = true
}

variable "groq_api_key" {
  type      = string
  sensitive = true
}

variable "database_url" {
  type      = string
  sensitive = true
}

variable "redis_url" {
  type      = string
  sensitive = true
}

variable "nexus_audit_key" {
  type      = string
  sensitive = true
  default   = ""
}

variable "region" {
  type    = string
  default = "ord"
}

# ── nexus-api ─────────────────────────────────────────────────────────────────

resource "fly_app" "nexus_api" {
  name = "nexus-api"
  org  = "personal"
}

resource "fly_machine" "nexus_api" {
  app    = fly_app.nexus_api.name
  region = var.region
  name   = "nexus-api-1"

  image = "ghcr.io/yash-awasthi/nexus-api:latest"

  services = [
    {
      internal_port = 3000
      protocol      = "tcp"
      ports = [
        { port = 443, handlers = ["tls", "http"] },
        { port = 80, handlers = ["http"] },
      ]
    }
  ]

  env = {
    PORT          = "3000"
    LOG_LEVEL     = "info"
    REDIS_URL     = var.redis_url
  }

  # Sensitive env vars as secrets (set separately with flyctl)
  # flyctl secrets set NEXUS_API_KEY=... DATABASE_URL=... GROQ_API_KEY=... --app nexus-api

  cpus       = 1
  memory_mb  = 512
}

# ── nexus-worker ─────────────────────────────────────────────────────────────

resource "fly_app" "nexus_worker" {
  name = "nexus-worker"
  org  = "personal"
}

resource "fly_machine" "nexus_worker" {
  app    = fly_app.nexus_worker.name
  region = var.region
  name   = "nexus-worker-1"

  image = "ghcr.io/yash-awasthi/nexus-worker:latest"

  env = {
    LOG_LEVEL = "info"
    REDIS_URL = var.redis_url
  }

  cpus      = 1
  memory_mb = 1024
}

# ── nexus-ingest ──────────────────────────────────────────────────────────────

resource "fly_app" "nexus_ingest" {
  name = "nexus-ingest"
  org  = "personal"
}

resource "fly_machine" "nexus_ingest" {
  app    = fly_app.nexus_ingest.name
  region = var.region
  name   = "nexus-ingest-1"

  image = "ghcr.io/yash-awasthi/nexus-ingest:latest"

  services = [
    {
      internal_port = 8000
      protocol      = "tcp"
      ports = [
        { port = 443, handlers = ["tls", "http"] },
      ]
    }
  ]

  env = {
    APP_ENV   = "production"
    LOG_LEVEL = "info"
  }

  cpus      = 1
  memory_mb = 512
}

# ── Outputs ───────────────────────────────────────────────────────────────────

output "api_url" {
  value = "https://${fly_app.nexus_api.name}.fly.dev"
}

output "ingest_url" {
  value = "https://${fly_app.nexus_ingest.name}.fly.dev"
}
