#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""
floci_bridge.py — GhostStack Floci bridge (port 4567).

Translates GhostStack's custom /_floci/extended/<action> HTTP API into
real AWS SDK calls against the Floci emulator (floci/floci:latest) which
runs the standard AWS wire protocol on port 4566.

Endpoints
---------
GET  /_floci/health                 — liveness + Floci reachability probe
POST /_floci/extended/<action>      — dispatch one of 16 AWS actions via boto3

Supported actions
-----------------
S3:        create_s3_bucket, delete_s3_bucket, put_s3_object,
           get_s3_object, list_s3_buckets
SQS:       create_sqs_queue, send_sqs_message, receive_sqs_messages
DynamoDB:  create_dynamodb_table, put_dynamodb_item, get_dynamodb_item
Lambda:    create_lambda, invoke_lambda, delete_lambda
SNS:       create_sns_topic, publish_sns_message

Configuration
-------------
FLOCI_BACKEND_URL   URL of the Floci/LocalStack emulator (default: http://localhost:4566)
AWS_DEFAULT_REGION  Region passed to boto3 clients (default: us-east-1)

Dependencies
------------
    pip install fastapi uvicorn boto3
"""
from __future__ import annotations

import argparse
import base64
import json
import logging
import os
from typing import Any

from fastapi import FastAPI, HTTPException, Path
from fastapi.responses import JSONResponse
import httpx

logger = logging.getLogger("floci_bridge")
logging.basicConfig(level=logging.INFO, format="%(levelname)s  %(name)s  %(message)s")


def _sanitize_log(val: Any) -> str:
    """Strip newlines/control chars from user-supplied values before logging."""
    return str(val).replace("\n", "\\n").replace("\r", "\\r").replace("\0", "")[:500]


FLOCI_BACKEND_URL: str = os.environ.get("FLOCI_BACKEND_URL", "http://localhost:4566")
AWS_REGION: str = os.environ.get("AWS_DEFAULT_REGION", "us-east-1")

# ---------------------------------------------------------------------------
# Optional boto3 import
# ---------------------------------------------------------------------------
try:
    import boto3  # type: ignore[import]
    from botocore.exceptions import ClientError  # type: ignore[import]
    BOTO3_AVAILABLE = True
except ImportError:
    BOTO3_AVAILABLE = False
    logger.warning(
        "boto3 not installed — Floci actions will return errors. "
        "Run: pip install boto3"
    )


# ---------------------------------------------------------------------------
# AWS client factory
# ---------------------------------------------------------------------------

def _client(service: str) -> Any:
    """Create a boto3 client pointed at the Floci emulator."""
    return boto3.client(
        service,
        endpoint_url=FLOCI_BACKEND_URL,
        region_name=AWS_REGION,
        # Floci requires exactly "test"/"test" as credentials per its test suite.
        # Any other value causes SigV4 signing failures against the emulator.
        aws_access_key_id=os.environ.get("AWS_ACCESS_KEY_ID", "test"),
        aws_secret_access_key=os.environ.get("AWS_SECRET_ACCESS_KEY", "test"),
    )


# ---------------------------------------------------------------------------
# Action dispatch table
# ---------------------------------------------------------------------------

def _dispatch(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Map an action name + payload to the appropriate boto3 call."""
    if not BOTO3_AVAILABLE:
        raise RuntimeError("boto3 not available — run: pip install boto3")

    # ── S3 ──────────────────────────────────────────────────────────────────
    if action == "create_s3_bucket":
        s3 = _client("s3")
        kwargs: dict[str, Any] = {"Bucket": payload["bucket"]}
        region = payload.get("region", AWS_REGION)
        if region and region != "us-east-1":
            kwargs["CreateBucketConfiguration"] = {"LocationConstraint": region}
        s3.create_bucket(**kwargs)
        return {"bucket": payload["bucket"], "created": True}

    if action == "delete_s3_bucket":
        s3 = _client("s3")
        s3.delete_bucket(Bucket=payload["bucket"])
        return {"bucket": payload["bucket"], "deleted": True}

    if action == "put_s3_object":
        s3 = _client("s3")
        body = payload.get("body", "")
        if isinstance(body, str):
            body = body.encode()
        kwargs = {
            "Bucket": payload["bucket"],
            "Key": payload["key"],
            "Body": body,
        }
        if ct := payload.get("content_type"):
            kwargs["ContentType"] = ct
        resp = s3.put_object(**kwargs)
        return {"bucket": payload["bucket"], "key": payload["key"], "etag": resp.get("ETag", "")}

    if action == "get_s3_object":
        s3 = _client("s3")
        resp = s3.get_object(Bucket=payload["bucket"], Key=payload["key"])
        body = resp["Body"].read()
        return {
            "bucket": payload["bucket"],
            "key": payload["key"],
            "body": body.decode("utf-8", errors="replace"),
            "content_type": resp.get("ContentType", ""),
            "content_length": resp.get("ContentLength", 0),
        }

    if action == "list_s3_buckets":
        s3 = _client("s3")
        resp = s3.list_buckets()
        return {"buckets": [b["Name"] for b in resp.get("Buckets", [])]}

    # ── SQS ─────────────────────────────────────────────────────────────────
    if action == "create_sqs_queue":
        sqs = _client("sqs")
        kwargs = {"QueueName": payload["queue_name"]}
        if attrs := payload.get("attributes"):
            kwargs["Attributes"] = attrs
        resp = sqs.create_queue(**kwargs)
        return {"queue_url": resp["QueueUrl"], "queue_name": payload["queue_name"]}

    if action == "send_sqs_message":
        sqs = _client("sqs")
        kwargs = {
            "QueueUrl": payload["queue_url"],
            "MessageBody": payload["message_body"],
        }
        if delay := payload.get("delay_seconds"):
            kwargs["DelaySeconds"] = int(delay)
        resp = sqs.send_message(**kwargs)
        return {"message_id": resp["MessageId"], "md5": resp.get("MD5OfMessageBody", "")}

    if action == "receive_sqs_messages":
        sqs = _client("sqs")
        resp = sqs.receive_message(
            QueueUrl=payload["queue_url"],
            MaxNumberOfMessages=int(payload.get("max_messages", 10)),
            WaitTimeSeconds=int(payload.get("wait_time_seconds", 0)),
        )
        msgs = resp.get("Messages", [])
        return {
            "messages": [
                {
                    "message_id": m["MessageId"],
                    "body": m["Body"],
                    "receipt_handle": m["ReceiptHandle"],
                }
                for m in msgs
            ],
            "count": len(msgs),
        }

    # ── DynamoDB ─────────────────────────────────────────────────────────────
    if action == "create_dynamodb_table":
        ddb = _client("dynamodb")
        resp = ddb.create_table(
            TableName=payload["table_name"],
            KeySchema=payload["key_schema"],
            AttributeDefinitions=payload["attribute_definitions"],
            BillingMode=payload.get("billing_mode", "PAY_PER_REQUEST"),
        )
        return {
            "table_name": payload["table_name"],
            "status": resp["TableDescription"]["TableStatus"],
        }

    if action == "put_dynamodb_item":
        ddb = _client("dynamodb")
        ddb.put_item(TableName=payload["table_name"], Item=payload["item"])
        return {"table_name": payload["table_name"], "written": True}

    if action == "get_dynamodb_item":
        ddb = _client("dynamodb")
        resp = ddb.get_item(TableName=payload["table_name"], Key=payload["key"])
        return {
            "table_name": payload["table_name"],
            "item": resp.get("Item"),
            "found": "Item" in resp,
        }

    # ── Lambda ───────────────────────────────────────────────────────────────
    if action == "create_lambda":
        lmb = _client("lambda")
        resp = lmb.create_function(
            FunctionName=payload["function_name"],
            Runtime=payload["runtime"],
            Role=payload["role"],
            Handler=payload["handler"],
            Code=payload["code"],
            Description=payload.get("description", ""),
        )
        return {
            "function_name": resp["FunctionName"],
            "function_arn": resp["FunctionArn"],
            "state": resp.get("State", ""),
        }

    if action == "invoke_lambda":
        lmb = _client("lambda")
        invoke_payload = payload.get("payload", {})
        resp = lmb.invoke(
            FunctionName=payload["function_name"],
            Payload=json.dumps(invoke_payload).encode(),
        )
        result_payload = resp["Payload"].read()
        return {
            "function_name": payload["function_name"],
            "status_code": resp["StatusCode"],
            "result": json.loads(result_payload) if result_payload else None,
            "error": resp.get("FunctionError", ""),
        }

    if action == "delete_lambda":
        lmb = _client("lambda")
        lmb.delete_function(FunctionName=payload["function_name"])
        return {"function_name": payload["function_name"], "deleted": True}

    # ── SNS ──────────────────────────────────────────────────────────────────
    if action == "create_sns_topic":
        sns = _client("sns")
        resp = sns.create_topic(Name=payload["name"])
        return {"topic_arn": resp["TopicArn"], "name": payload["name"]}

    if action == "publish_sns_message":
        sns = _client("sns")
        kwargs = {
            "TopicArn": payload["topic_arn"],
            "Message": payload["message"],
        }
        if subj := payload.get("subject"):
            kwargs["Subject"] = subj
        resp = sns.publish(**kwargs)
        return {"message_id": resp["MessageId"]}

    raise ValueError(f"Unknown Floci action: {action!r}")


# ---------------------------------------------------------------------------
# App factory
# ---------------------------------------------------------------------------

def create_app() -> FastAPI:
    app = FastAPI(title="GhostStack Floci Bridge")

    @app.get("/_floci/health")
    async def health() -> dict[str, Any]:
        """
        Check bridge liveness and probe whether Floci itself is reachable.
        Floci exposes /_localstack/health for LocalStack compatibility.
        """
        floci_ok = False
        floci_error = ""
        try:
            async with httpx.AsyncClient(timeout=3.0) as client:
                resp = await client.get(f"{FLOCI_BACKEND_URL}/_localstack/health")
                floci_ok = resp.status_code < 400
        except Exception as exc:
            logger.error("Floci health probe failed: %s", exc)
            floci_error = "unreachable"

        return {
            "status": "ok",
            "boto3": BOTO3_AVAILABLE,
            "floci_backend": FLOCI_BACKEND_URL,
            "floci_reachable": floci_ok,
            "floci_error": floci_error if not floci_ok else "",
        }

    @app.post("/_floci/extended/{action}")
    async def extended_action(
        action: str = Path(..., description="Floci extended action name"),
        payload: dict[str, Any] = None,  # type: ignore[assignment]
    ) -> JSONResponse:
        if payload is None:
            payload = {}
        try:
            result = _dispatch(action, payload)
            return JSONResponse(result)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:
            # boto3 ClientError or connection errors
            logger.error("Floci action %s failed: %s", _sanitize_log(action), exc)
            raise HTTPException(status_code=502, detail="Upstream service error — check server logs") from exc

    return app


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    import uvicorn  # type: ignore[import]
    parser = argparse.ArgumentParser(description="GhostStack Floci bridge")
    parser.add_argument("--port", type=int, default=4567, help="Listen port (default: 4567)")
    parser.add_argument("--host", default="127.0.0.1", help="Listen host (default: 127.0.0.1)")
    args = parser.parse_args()
    logger.info(
        "Starting Floci bridge on %s:%d  (Floci backend: %s)",
        args.host, args.port, FLOCI_BACKEND_URL,
    )
    uvicorn.run(create_app(), host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
