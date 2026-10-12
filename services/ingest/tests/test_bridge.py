# SPDX-License-Identifier: Apache-2.0
"""fin-scrape bridge: /scan pushes each file once, moves it, and reports bad files without detail."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, patch

from nexus_ingest.settings import Settings


def _settings(tmp_path: Path) -> Settings:
    return Settings(
        FINSCRAPE_OUTPUT_DIR=str(tmp_path / "out"),
        FINSCRAPE_DONE_DIR=str(tmp_path / "done"),
        NEXUS_API_URL="http://nexus.test",
        NEXUS_API_SECRET="secret",
    )


async def test_scan_pushes_and_moves_valid_files(client, auth_headers, tmp_path: Path) -> None:
    out = tmp_path / "out"
    out.mkdir()
    (out / "a.json").write_text(json.dumps({"event_type": "market.ticker", "payload": {"t": 1}}))
    (out / "b.json").write_text(json.dumps({"payload": {}}))  # no event_type
    (out / "c.json").write_text("{not json")
    (out / "d.json").write_text(json.dumps({"event_type": "x"}))
    pushed: list[tuple[str, str, dict[str, Any]]] = []

    async def fake_push(source: str, event_type: str, payload: dict[str, Any]) -> dict[str, Any]:
        if event_type == "x":
            raise RuntimeError("upstream said no")
        pushed.append((source, event_type, payload))
        return {"event_id": "e1"}

    with (
        patch("nexus_ingest.routes.bridge.get_settings", return_value=_settings(tmp_path)),
        patch("nexus_ingest.routes.bridge.push_event", side_effect=fake_push),
    ):
        resp = await client.post("/scan", headers=auth_headers)

    body = resp.json()
    assert resp.status_code == 200
    assert (body["pushed"], body["failed"], body["skipped"]) == (1, 1, 2)
    assert body["errors"] == ["d.json"]
    assert pushed == [("finscrape", "market.ticker", {"t": 1})]
    assert (tmp_path / "done" / "a.json").exists() and not (out / "a.json").exists()
    assert (out / "d.json").exists()


async def test_push_forwards_one_event(client, auth_headers) -> None:
    with patch(
        "nexus_ingest.routes.bridge.push_event", new=AsyncMock(return_value={"event_id": "e9"})
    ):
        resp = await client.post(
            "/push", headers=auth_headers, json={"event_type": "t", "payload": {}}
        )
    assert resp.status_code == 200
    assert resp.json()["event_id"] == "e9"


async def test_bridge_requires_the_ingest_key(client, bad_auth_headers) -> None:
    resp = await client.post("/scan", headers=bad_auth_headers)
    assert resp.status_code == 401
