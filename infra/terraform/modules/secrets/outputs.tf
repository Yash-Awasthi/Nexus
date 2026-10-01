# SPDX-License-Identifier: Apache-2.0
output "service_tokens" {
  description = "Map of service name → Doppler service token (inject as DOPPLER_TOKEN)"
  value       = { for svc, tok in doppler_service_token.services : svc => tok.key }
  sensitive   = true
}

output "all_secrets" {
  description = "All secrets in the Doppler config as a map (use sparingly — prefer service tokens)"
  value       = data.doppler_secrets.env.map
  sensitive   = true
}
