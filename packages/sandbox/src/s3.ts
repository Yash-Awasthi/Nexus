// SPDX-License-Identifier: Apache-2.0
/**
 * The drive's S3-compatible bucket (S3, R2, B2, MinIO), named by DRIVE_BACKUP_S3_*: path-style
 * calls signed with SigV4. Drive backups keep their archives in it, and the API keeps
 * `/v1/files` bytes there so every API process sees the same files.
 */
import { AwsClient } from "aws4fetch";

export interface S3Config {
  /** e.g. https://<account>.r2.cloudflarestorage.com or https://s3.<region>.amazonaws.com */
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
}

/** The bucket named by DRIVE_BACKUP_S3_*, or null when it is not configured. */
export function s3ConfigFromEnv(env: NodeJS.ProcessEnv = process.env): S3Config | null {
  const { DRIVE_BACKUP_S3_BUCKET: bucket, DRIVE_BACKUP_S3_ACCESS_KEY_ID: accessKeyId } = env;
  const secretAccessKey = env.DRIVE_BACKUP_S3_SECRET_ACCESS_KEY;
  if (!bucket || !accessKeyId || !secretAccessKey) return null;
  const region = env.DRIVE_BACKUP_S3_REGION ?? "auto";
  return {
    endpoint: (env.DRIVE_BACKUP_S3_ENDPOINT ?? `https://s3.${region}.amazonaws.com`).replace(
      /\/$/,
      "",
    ),
    bucket,
    region,
    accessKeyId,
    secretAccessKey,
    prefix: env.DRIVE_BACKUP_S3_PREFIX ?? "drives/",
  };
}

export interface S3Bucket {
  /** Objects under `prefix` (one page, up to 1000), with when each was written. */
  list(prefix: string): Promise<{ key: string; at: number }[]>;
  put(key: string, body: RequestInit["body"], headers?: Record<string, string>): Promise<void>;
  /** The object's bytes, or null when there is none. */
  get(key: string): Promise<Buffer | null>;
  remove(key: string): Promise<void>;
}

/** `fetchFn` receives each signed request; tests pass a fake bucket. */
export function s3Bucket(
  cfg: S3Config,
  fetchFn: (req: Request) => Promise<Response> = (req) => fetch(req),
): S3Bucket {
  const aws = new AwsClient({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    service: "s3",
    region: cfg.region,
  });
  const keyUrl = (key: string) =>
    `${cfg.endpoint}/${cfg.bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
  const call = async (url: string, init: RequestInit & { duplex?: "half" } = {}) => {
    const res = await fetchFn(await aws.sign(url, init));
    if (!res.ok && !(res.status === 404 && (init.method ?? "GET") === "GET"))
      throw new Error(
        `S3 ${init.method ?? "GET"} ${res.status}: ${(await res.text()).slice(0, 200)}`,
      );
    return res;
  };
  return {
    async list(prefix) {
      const xml = await (
        await call(`${cfg.endpoint}/${cfg.bucket}?list-type=2&prefix=${encodeURIComponent(prefix)}`)
      ).text();
      return [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].flatMap(([, item]) => {
        const key = /<Key>([^<]+)<\/Key>/.exec(item!)?.[1];
        const at = Date.parse(/<LastModified>([^<]+)<\/LastModified>/.exec(item!)?.[1] ?? "");
        return key ? [{ key, at }] : [];
      });
    },
    async put(key, body, headers = {}) {
      await call(keyUrl(key), { method: "PUT", headers, body, duplex: "half" });
    },
    async get(key) {
      const res = await call(keyUrl(key));
      return res.status === 404 ? null : Buffer.from(await res.arrayBuffer());
    },
    async remove(key) {
      await call(keyUrl(key), { method: "DELETE" });
    },
  };
}
