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
#
# Go and Rust come from their official releases, pinned by version and checked by
# SHA-256, not from Debian: bookworm's golang-go is 1.19 and its rustc is 1.63,
# both years past security support, and this is the one image that runs code we
# did not write. Ruby is compiled from its official release in a throwaway stage
# for the same reason: bookworm's ruby is 3.1.2, end-of-life since 2025-03-31.
# The assertion step below fails the build when the version that runs is not the
# version that was pinned, and records the exact output in
# /usr/local/share/nexus-toolchains.txt and in the image label.

# Ruby build stage. The compilers and headers stay here; only /opt/ruby travels.
FROM node:26-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS ruby

ARG RUBY_VERSION=3.4.13

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      build-essential \
      bison \
      libssl-dev \
      libyaml-dev \
      libreadline-dev \
      zlib1g-dev \
      libffi-dev \
 && rm -rf /var/lib/apt/lists/*

# Official Ruby release, checksum-pinned. Not --enable-shared: a static libruby
# needs no loader path, which matters when the rootfs is read-only at run time.
RUN set -eux; \
    curl -fsSL -o /tmp/ruby.tar.gz \
      "https://cache.ruby-lang.org/pub/ruby/3.4/ruby-${RUBY_VERSION}.tar.gz"; \
    echo "d0d3bf3dd8c224a3c3b7ecd816a0f1b2cbcf4f87b5afcbdbe91d3fef177f351a  /tmp/ruby.tar.gz" \
      | sha256sum -c -; \
    mkdir -p /tmp/ruby; \
    tar -C /tmp/ruby -xzf /tmp/ruby.tar.gz; \
    cd "/tmp/ruby/ruby-${RUBY_VERSION}"; \
    ./configure --prefix=/opt/ruby --disable-install-doc; \
    make -j"$(nproc)"; \
    make install; \
    rm -rf /tmp/ruby /tmp/ruby.tar.gz

FROM node:26-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1

ARG GO_VERSION=1.27.4
ARG RUST_VERSION=1.100.0
ARG RUBY_VERSION=3.4.13

ENV DEBIAN_FRONTEND=noninteractive \
    HOME=/nexus-scratch \
    GOCACHE=/nexus-scratch/go-build \
    GOPATH=/nexus-scratch/go \
    GOTOOLCHAIN=local \
    CARGO_HOME=/nexus-scratch/cargo \
    npm_config_cache=/nexus-scratch/npm \
    PYTHONDONTWRITEBYTECODE=1 \
    LANG=C.UTF-8 \
    PATH=/usr/local/go/bin:/opt/ruby/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Ruby from the build stage above; the apt ruby package is deliberately absent.
COPY --from=ruby /opt/ruby /opt/ruby

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      curl \
      xz-utils \
      python3 \
      gcc \
      libc6-dev \
 && rm -rf /var/lib/apt/lists/* \
 && npm install --global --no-audit --no-fund tsx

# Official Go release, checksum-pinned. The tarball is architecture-specific, so
# an unknown arch fails loudly instead of installing whatever Debian has.
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "${arch}" in \
      amd64) go_sha=7226736c2339719cda28fbf3a54d71aa63bcefe376e98cef00034268dab24840 ;; \
      arm64) go_sha=3392582988a273a87ab5043ee1b2c9c17a2c3c00580bf9326c47a2e0aaaeac92 ;; \
      *) echo "sandbox image: unsupported architecture ${arch}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/go.tar.gz "https://go.dev/dl/go${GO_VERSION}.linux-${arch}.tar.gz"; \
    echo "${go_sha}  /tmp/go.tar.gz" | sha256sum -c -; \
    tar -C /usr/local -xzf /tmp/go.tar.gz; \
    rm -f /tmp/go.tar.gz

# Official Rust release, checksum-pinned, rustc + cargo + std only (no docs,
# clippy or rustfmt in the untrusted-code image).
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "${arch}" in \
      amd64) rust_target=x86_64-unknown-linux-gnu; rust_sha=98ee6bec240e1cfe944f17e7092412dc5ef6e008484bb668c6936d35a7d15acd ;; \
      arm64) rust_target=aarch64-unknown-linux-gnu; rust_sha=a21f6a21818df07c1e2e7addb570af5444b3fa9dd61e3a207f4fb1c5a5e665c9 ;; \
      *) echo "sandbox image: unsupported architecture ${arch}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/rust.tar.xz "https://static.rust-lang.org/dist/rust-${RUST_VERSION}-${rust_target}.tar.xz"; \
    echo "${rust_sha}  /tmp/rust.tar.xz" | sha256sum -c -; \
    mkdir -p /tmp/rust; \
    tar -C /tmp/rust -xJf /tmp/rust.tar.xz; \
    "/tmp/rust/rust-${RUST_VERSION}-${rust_target}/install.sh" \
      --prefix=/usr/local \
      --components="rustc,cargo,rust-std-${rust_target}" \
      --disable-ldconfig; \
    rm -rf /tmp/rust /tmp/rust.tar.xz

# The base image's uid 1000 account is "node"; the runner passes --user 1000:1000,
# so give that same uid a writable home instead of adding a second account.
RUN groupmod --new-name sandbox node \
 && usermod --login sandbox --home /nexus-scratch --shell /bin/bash node \
 && mkdir -p /nexus-scratch /workspace /nexus-src /nexus-out \
 && chown sandbox:sandbox /nexus-scratch \
 && chmod 1777 /workspace /nexus-src /nexus-out

# Assert the toolchains and record them. Dockerfile LABEL cannot hold command
# output, so the label carries the pins and this step proves the pins are what
# actually runs; the runtime file carries the exact `--version` lines. Go, Rust
# and Ruby are matched against their pins; Node and Python come from the base
# image and Debian release, so their major is what the build guarantees.
RUN set -eux; \
    mkdir -p /usr/local/share; \
    : > /usr/local/share/nexus-toolchains.txt; \
    for cmd in "go version" "rustc --version" "ruby --version" \
               "node --version" "python3 --version"; do \
      ${cmd} | head -1 >> /usr/local/share/nexus-toolchains.txt; \
    done; \
    arch="$(dpkg --print-architecture)"; \
    grep -qx "go version go${GO_VERSION} linux/${arch}" /usr/local/share/nexus-toolchains.txt; \
    grep -Eq "^rustc ${RUST_VERSION} " /usr/local/share/nexus-toolchains.txt; \
    grep -Eq "^ruby ${RUBY_VERSION}" /usr/local/share/nexus-toolchains.txt; \
    grep -Eq '^v26\.' /usr/local/share/nexus-toolchains.txt; \
    grep -Eq '^Python 3\.' /usr/local/share/nexus-toolchains.txt; \
    chmod 0644 /usr/local/share/nexus-toolchains.txt; \
    cat /usr/local/share/nexus-toolchains.txt

LABEL org.nexus.toolchains="go=${GO_VERSION} rust=${RUST_VERSION} ruby=${RUBY_VERSION} node=26 python3=debian-bookworm" \
      org.nexus.toolchains-file="/usr/local/share/nexus-toolchains.txt"

USER 1000:1000
WORKDIR /workspace
CMD ["bash"]
