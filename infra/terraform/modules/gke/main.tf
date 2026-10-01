# SPDX-License-Identifier: Apache-2.0
# modules/gke/main.tf — GKE cluster for the Helm chart (infra/helm/nexus)
#
# A regional cluster with one autoscaling node pool. Workload Identity is on, so pods can use
# Google service accounts without keys.
#
# Usage:
#   module "gke" {
#     source     = "../../modules/gke"
#     project_id = "my-project"
#     name       = "nexus"
#     region     = "us-central1"
#   }

terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

resource "google_container_cluster" "this" {
  project  = var.project_id
  name     = var.name
  location = var.region

  # The default pool is replaced by the managed pool below.
  remove_default_node_pool = true
  initial_node_count       = 1

  release_channel {
    channel = var.release_channel
  }

  workload_identity_config {
    workload_pool = "${var.project_id}.svc.id.goog"
  }

  deletion_protection = var.deletion_protection
}

resource "google_container_node_pool" "default" {
  project  = var.project_id
  name     = "${var.name}-pool"
  location = var.region
  cluster  = google_container_cluster.this.name

  autoscaling {
    min_node_count = var.min_nodes
    max_node_count = var.max_nodes
  }

  node_config {
    machine_type = var.machine_type
    disk_size_gb = var.disk_size_gb
    oauth_scopes = ["https://www.googleapis.com/auth/cloud-platform"]

    workload_metadata_config {
      mode = "GKE_METADATA"
    }
  }

  management {
    auto_repair  = true
    auto_upgrade = true
  }
}
