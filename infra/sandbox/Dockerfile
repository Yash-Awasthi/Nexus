# SPDX-License-Identifier: Apache-2.0
# Runtime for untrusted code: skill code, missions and model-written shell.
#
# packages/sandbox/src/index.ts starts this image with --network=none, a
# read-only rootfs, a tmpfs at /nexus-scratch, --cap-drop=ALL and uid 1000.
# Everything a language needs to write at run time therefore has to live under
# /nexus-scratch; HOME, the Go and Cargo caches and npm's cache all point there.
#
# Build:  docker build -t nexus-sandbox:local infra/sandbox
# Or:     docker compose --profile tools build sandbox
FROM node:26-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1

ENV DEBIAN_FRONTEND=noninteractive \
    HOME=/nexus-scratch \
    GOCACHE=/nexus-scratch/go-build \
    GOPATH=/nexus-scratch/go \
    GOTOOLCHAIN=local \
    CARGO_HOME=/nexus-scratch/cargo \
    npm_config_cache=/nexus-scratch/npm \
    PYTHONDONTWRITEBYTECODE=1 \
    LANG=C.UTF-8

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      python3 \
      golang-go \
      rustc \
      cargo \
      ruby \
 && rm -rf /var/lib/apt/lists/* \
 && npm install --global --no-audit --no-fund tsx

# The base image's uid 1000 account is "node"; the runner passes --user 1000:1000,
# so give that same uid a writable home instead of adding a second account.
RUN groupmod --new-name sandbox node \
 && usermod --login sandbox --home /nexus-scratch --shell /bin/bash node \
 && mkdir -p /nexus-scratch /workspace /nexus-src /nexus-out \
 && chown sandbox:sandbox /nexus-scratch \
 && chmod 1777 /workspace /nexus-src /nexus-out

USER 1000:1000
WORKDIR /workspace
CMD ["bash"]
