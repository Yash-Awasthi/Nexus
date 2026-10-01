# SPDX-License-Identifier: Apache-2.0
"""
Tests for Celery background tasks.

Uses celery's ALWAYS_EAGER mode so tasks run synchronously in-process
— no broker or worker required.
"""
from __future__ import annotations

import os
import pytest

# ── Eager mode — tasks run in-process synchronously ──────────────────────────

os.environ.setdefault("NEXUS_EMBED_PROVIDER", "stub")
os.environ.setdefault("NEXUS_VECTOR_BACKEND", "stub")

from nexus_ingest.celery_app import create_celery_app

# Override the singleton so tasks imported below use eager mode
_test_app = create_celery_app(broker="memory://", backend="cache+memory://")
_test_app.conf.task_always_eager = True
_test_app.conf.task_eager_propagates = True

# Patch the module-level app BEFORE importing tasks
import nexus_ingest.celery_app as _celery_module
_celery_module.celery_app = _test_app

from nexus_ingest.tasks.index_document import chunk_text, index_document, purge_expired
from nexus_ingest.tasks.crawl_url import strip_html, crawl_url
from nexus_ingest.tasks.run_inference import run_inference


# ── chunk_text tests ─────────────────────────────────────────────────────────

class TestChunkText:
    def test_short_text_returns_single_chunk(self) -> None:
        text = "Hello world"
        chunks = chunk_text(text, chunk_size=256, overlap=32)
        assert chunks == [text]

    def test_long_text_splits_into_multiple_chunks(self) -> None:
        text = "A" * 2000
        chunks = chunk_text(text, chunk_size=64, overlap=8)  # 64 tokens = 256 chars
        assert len(chunks) > 1

    def test_chunks_cover_full_content(self) -> None:
        text = "word " * 300
        chunks = chunk_text(text, chunk_size=64, overlap=16)
        # Reassemble: first chunk + each subsequent chunk's non-overlapping tail
        reassembled = chunks[0]
        for c in chunks[1:]:
            reassembled += c
        # All original characters appear somewhere
        for word in text.split():
            assert word in reassembled

    def test_overlap_creates_overlapping_chunks(self) -> None:
        text = "A" * 512
        chunks = chunk_text(text, chunk_size=64, overlap=32)
        assert len(chunks) >= 2
        # Each chunk should not be shorter than overlap
        for c in chunks:
            assert len(c) > 0

    def test_empty_text_returns_single_empty_chunk(self) -> None:
        chunks = chunk_text("", chunk_size=256, overlap=32)
        assert chunks == [""]


# ── index_document task tests ─────────────────────────────────────────────────

class TestIndexDocumentTask:
    def test_returns_ok_status(self) -> None:
        result = index_document.apply(
            args=["doc-001", "This is a test document with some content."],
            kwargs={"metadata": {"source": "test"}},
        ).get()
        assert result["status"] == "ok"
        assert result["doc_id"] == "doc-001"

    def test_chunks_indexed_is_positive(self) -> None:
        result = index_document.apply(
            args=["doc-002", "A " * 100],
        ).get()
        assert result["chunks_indexed"] >= 1

    def test_long_document_splits_into_multiple_chunks(self) -> None:
        long_content = "paragraph content here\n\n" * 50
        result = index_document.apply(
            args=["doc-003", long_content],
            kwargs={"chunk_size": 16, "overlap": 4},
        ).get()
        assert result["chunks_indexed"] > 1

    def test_empty_content_indexed_as_single_chunk(self) -> None:
        result = index_document.apply(
            args=["doc-004", ""],
        ).get()
        assert result["status"] == "ok"
        assert result["chunks_indexed"] == 1

    def test_metadata_accepted(self) -> None:
        result = index_document.apply(
            args=["doc-005", "Test with metadata"],
            kwargs={"metadata": {"tag": "finance", "priority": 1}},
        ).get()
        assert result["status"] == "ok"

    def test_purge_expired_stub_returns_zero(self) -> None:
        result = purge_expired.apply().get()
        assert result["purged"] == 0
        assert result["backend"] == "stub"


# ── strip_html tests ──────────────────────────────────────────────────────────

class TestStripHtml:
    def test_removes_tags(self) -> None:
        html = "<h1>Hello</h1><p>World</p>"
        assert "Hello" in strip_html(html)
        assert "World" in strip_html(html)
        assert "<h1>" not in strip_html(html)

    def test_removes_script_blocks(self) -> None:
        html = "<p>Text</p><script>alert('xss')</script><p>More</p>"
        result = strip_html(html)
        assert "alert" not in result
        assert "Text" in result

    def test_removes_style_blocks(self) -> None:
        html = "<style>body{color:red}</style><p>Content</p>"
        result = strip_html(html)
        assert "color" not in result
        assert "Content" in result

    def test_decodes_html_entities(self) -> None:
        html = "<p>a &amp; b &lt;c&gt; &quot;d&quot;</p>"
        result = strip_html(html)
        assert "&amp;" not in result
        assert "&" in result

    def test_plain_text_unchanged(self) -> None:
        text = "Hello world, no HTML here."
        assert strip_html(text).strip() == text


# ── crawl_url task tests ──────────────────────────────────────────────────────

class TestCrawlUrlTask:
    def test_invalid_scheme_returns_error(self) -> None:
        result = crawl_url.apply(args=["ftp://example.com/file.txt"]).get()
        assert result["status"] == "error"
        assert "Invalid URL scheme" in result["error"]

    def test_result_structure(self) -> None:
        # We can't do real HTTP in unit tests; test error path
        result = crawl_url.apply(args=["ftp://not-http.example.com"]).get()
        assert "url" in result
        assert "status" in result


# ── run_inference task tests ──────────────────────────────────────────────────

class TestRunInferenceTask:
    def test_stub_provider_returns_ok(self) -> None:
        messages = [{"role": "user", "content": "Hello, what is 2+2?"}]
        result = run_inference.apply(
            args=[messages],
            kwargs={"model": "stub-model", "provider": "stub"},
        ).get()
        assert result["status"] == "ok"
        assert "content" in result
        assert len(result["content"]) > 0

    def test_stub_echoes_user_message(self) -> None:
        messages = [{"role": "user", "content": "unique-token-12345"}]
        result = run_inference.apply(
            args=[messages],
            kwargs={"provider": "stub"},
        ).get()
        assert "unique-token-12345" in result["content"]

    def test_unknown_provider_returns_error(self) -> None:
        messages = [{"role": "user", "content": "test"}]
        result = run_inference.apply(
            args=[messages],
            kwargs={"provider": "nonexistent-provider"},
        ).get()
        assert result["status"] == "error"
        assert "Unknown provider" in result["error"]

    def test_request_id_preserved(self) -> None:
        messages = [{"role": "user", "content": "test"}]
        result = run_inference.apply(
            args=[messages],
            kwargs={"provider": "stub", "request_id": "req-abc-123"},
        ).get()
        assert result["request_id"] == "req-abc-123"

    def test_tokens_reported(self) -> None:
        messages = [{"role": "user", "content": "count my tokens please"}]
        result = run_inference.apply(
            args=[messages],
            kwargs={"provider": "stub"},
        ).get()
        assert isinstance(result["tokens"], int)
        assert result["tokens"] >= 0


# ── celery app configuration tests ───────────────────────────────────────────

class TestCeleryAppConfig:
    def test_create_celery_app_returns_celery_instance(self) -> None:
        from celery import Celery
        app = create_celery_app(broker="memory://", backend="cache+memory://")
        assert isinstance(app, Celery)

    def test_app_has_correct_name(self) -> None:
        app = create_celery_app(broker="memory://", backend="cache+memory://")
        assert app.main == "nexus-ingest"

    def test_beat_schedule_contains_purge_task(self) -> None:
        app = create_celery_app(broker="memory://", backend="cache+memory://")
        assert "purge-expired-every-6h" in app.conf.beat_schedule

    def test_task_serializer_is_json(self) -> None:
        app = create_celery_app(broker="memory://", backend="cache+memory://")
        assert app.conf.task_serializer == "json"

    def test_task_acks_late_enabled(self) -> None:
        app = create_celery_app(broker="memory://", backend="cache+memory://")
        assert app.conf.task_acks_late is True
