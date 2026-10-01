// SPDX-License-Identifier: Apache-2.0
/** Drive backups to an S3-compatible bucket (R2 here), against a mock of the bucket's HTTP API. */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";

import { userDrivePath } from "@nexus/sandbox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleDriveBackupJob, s3BackupStore } from "../../src/handlers/drive-lifecycle.js";

const CFG = {
  endpoint: "https://acct123.r2.cloudflarestorage.com",
  bucket: "nexus-backups",
  region: "auto",
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "secret-example",
  prefix: "drives/",
};

/** An in-memory bucket speaking just enough of the S3 API: PUT, DELETE, ListObjectsV2. */
function mockBucket(seed: Record<string, Date> = {}) {
  const objects = new Map<string, { body: Buffer; at: Date }>(
    Object.entries(seed).map(([k, at]) => [k, { body: Buffer.alloc(0), at }]),
  );
  const requests: Request[] = [];
  const fetchFn = async (req: Request) => {
    requests.push(req.clone());
    const url = new URL(req.url);
    const key = decodeURIComponent(url.pathname.replace(`/${CFG.bucket}/`, ""));
    if (req.method === "PUT") {
      objects.set(key, { body: Buffer.from(await req.arrayBuffer()), at: new Date() });
      return new Response("", { status: 200 });
    }
    if (req.method === "DELETE") {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    const prefix = url.searchParams.get("prefix") ?? "";
    const items = [...objects]
      .filter(([k]) => k.startsWith(prefix))
      .map(
        ([k, o]) =>
          `<Contents><Key>${k}</Key><LastModified>${o.at.toISOString()}</LastModified></Contents>`,
      )
      .join("");
    return new Response(`<?xml version="1.0"?><ListBucketResult>${items}</ListBucketResult>`);
  };
  return { objects, requests, fetchFn };
}

let root: string;
let drive: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "drive-s3-test-"));
  drive = path.basename(userDrivePath("user-s3"));
  await fs.mkdir(path.join(root, drive));
  await fs.writeFile(path.join(root, drive, "notes.md"), "hello");
  await fs.writeFile(path.join(root, drive, ".env"), "OPENAI_API_KEY=sk-secret");
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("drive backups to S3 / R2", () => {
  it("uploads a signed tar.gz of each drive, without its .env", async () => {
    const bucket = mockBucket();
    const res = await handleDriveBackupJob({ root, store: s3BackupStore(CFG, bucket.fetchFn) });
    expect(res.backedUp).toEqual([drive]);

    const put = bucket.requests.find((r) => r.method === "PUT")!;
    expect(put.url).toMatch(
      new RegExp(
        `^https://acct123\\.r2\\.cloudflarestorage\\.com/nexus-backups/drives/${drive}/.+\\.tar\\.gz$`,
      ),
    );
    expect(put.headers.get("authorization")).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/auto\/s3\/aws4_request/,
    );
    expect(put.headers.get("x-amz-content-sha256")).toBe("UNSIGNED-PAYLOAD");
    const [[, stored]] = [...bucket.objects];
    const tar = gunzipSync(stored!.body).toString("latin1");
    expect(tar).toContain("notes.md");
    expect(tar).not.toContain("sk-secret");
  });

  it("skips a drive unchanged since its newest backup", async () => {
    const bucket = mockBucket({
      [`drives/${drive}/2999-01-01T00-00-00-000Z.tar.gz`]: new Date(Date.now() + 60_000),
    });
    const res = await handleDriveBackupJob({ root, store: s3BackupStore(CFG, bucket.fetchFn) });
    expect(res).toMatchObject({ backedUp: [], unchanged: 1 });
    expect(bucket.requests.some((r) => r.method === "PUT")).toBe(false);
  });

  it("keeps only the newest copies", async () => {
    const old = Object.fromEntries(
      [1, 2, 3].map((d) => [
        `drives/${drive}/2020-01-0${d}T00-00-00-000Z.tar.gz`,
        new Date(2020, 0, d),
      ]),
    );
    const bucket = mockBucket(old);
    await handleDriveBackupJob({ root, keep: 2, store: s3BackupStore(CFG, bucket.fetchFn) });
    const left = [...bucket.objects.keys()].sort();
    expect(left).toHaveLength(2);
    expect(left[0]).toBe(`drives/${drive}/2020-01-03T00-00-00-000Z.tar.gz`);
  });

  it("reports a failed upload and carries on", async () => {
    const bucket = mockBucket();
    const failing = async (req: Request) =>
      req.method === "PUT" ? new Response("denied", { status: 403 }) : bucket.fetchFn(req);
    const res = await handleDriveBackupJob({ root, store: s3BackupStore(CFG, failing) });
    expect(res.backedUp).toEqual([]);
  });
});
