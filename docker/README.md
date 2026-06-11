# Containerized Deployment Directory

This directory houses the Docker build and orchestration assets for containerized deployment of the **GhostStack Orchestrator Core**.

## Docker Configuration Files

- **[Dockerfile](Dockerfile)**: Multi-stage Alpine Node.js build. Compiles TypeScript to `dist/` and runs `node dist/runtime/bootstrap.js`.
- **[docker-compose.yaml](docker-compose.yaml)**: Orchestrator core with healthcheck (`dist/runtime/healthcheck.js`), persistent volumes, and port `8080`.
- **[docker-compose.optional.yaml](docker-compose.optional.yaml)**: Phase 2 **paperless-ngx** stack (Postgres, Redis, web on port `8001`). Not required for the orchestrator.

## Getting Started

To spin up GhostStack inside a Docker container:

```bash
# Build and boot the orchestrator core services
docker compose -f docker/docker-compose.yaml up --build -d

# Check live running logs
docker compose -f docker/docker-compose.yaml logs -f

# Verify that the container is healthy
docker ps --filter name=ghoststack-core-runner
```

### Optional: paperless-ngx (Phase 2)

```bash
docker compose -f docker/docker-compose.yaml -f docker/docker-compose.optional.yaml up -d
```

## Build Notes

- TypeScript compiles to `dist/` per root `tsconfig.json` (`outDir: ./dist`).
- Container CMD and healthcheck use compiled paths under `dist/runtime/`, not raw `.ts` sources.
