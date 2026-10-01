# SPDX-License-Identifier: Apache-2.0
"""nexus-ingest — application settings via pydantic-settings."""
from __future__ import annotations

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """All config comes from environment variables or .env file."""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Service
    app_env: str = Field("development", alias="APP_ENV")
    log_level: str = Field("info", alias="LOG_LEVEL")
    workers: int = Field(2, alias="WORKERS")

    # Scraper defaults
    max_articles: int = Field(20, alias="FINSCRAPE_MAX_ARTICLES")
    max_age_hours: float = Field(2.0, alias="FINSCRAPE_MAX_AGE_HOURS")

    # Nexus API push target (optional)
    nexus_api_url: str | None = Field(None, alias="NEXUS_API_URL")
    nexus_api_secret: str | None = Field(None, alias="NEXUS_API_SECRET")

    # Database (optional — for persisting ingested events)
    database_url: str | None = Field(None, alias="DATABASE_URL")

    # Observability
    otel_exporter_otlp_endpoint: str | None = Field(None, alias="OTEL_EXPORTER_OTLP_ENDPOINT")
    otel_service_name: str = Field("nexus-ingest", alias="OTEL_SERVICE_NAME")


_settings: Settings | None = None


def get_settings() -> Settings:
    global _settings
    if _settings is None:
        _settings = Settings()
    return _settings
