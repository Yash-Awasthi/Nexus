FROM python:3.12-slim

LABEL org.opencontainers.image.title="nexus-ingest-py" \
      org.opencontainers.image.description="fin-scrape → Nexus ingest API bridge"

# ── System deps ───────────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
  && rm -rf /var/lib/apt/lists/*

# ── Python deps ───────────────────────────────────────────────────────────────
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ── App source ────────────────────────────────────────────────────────────────
COPY main.py .

# ── Data volumes ──────────────────────────────────────────────────────────────
# Mount fin-scrape output at /data/finscrape (override FINSCRAPE_OUTPUT_DIR)
VOLUME ["/data/finscrape"]

# ── Runtime ───────────────────────────────────────────────────────────────────
EXPOSE 8001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:8001/health || exit 1

ENV NEXUS_API_URL=http://api:3000 \
    BRIDGE_PORT=8001 \
    LOG_LEVEL=info

CMD ["python", "main.py"]
