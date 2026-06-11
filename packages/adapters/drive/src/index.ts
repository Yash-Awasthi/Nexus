// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/adapter-drive — Google Drive REST API.
 * Task types: drive.upload, drive.download, drive.list, drive.create-folder
 */

import { defineAdapter, requireEnv, AdapterHttpError, type IExecutionContext } from "@nexus/plugin-sdk";

const DRIVE_BASE = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3";

export interface DriveUploadTask { taskType: "drive.upload"; name: string; content: string; mimeType?: string; parentId?: string; }
export interface DriveDownloadTask { taskType: "drive.download"; fileId: string; }
export interface DriveListTask { taskType: "drive.list"; folderId?: string; mimeType?: string; maxResults?: number; }
export interface DriveCreateFolderTask { taskType: "drive.create-folder"; name: string; parentId?: string; }
export type DriveTask = DriveUploadTask | DriveDownloadTask | DriveListTask | DriveCreateFolderTask;
export interface DriveFileResult { id: string; name: string; mimeType: string; webViewLink?: string; }
export interface DriveListResult { files: DriveFileResult[]; nextPageToken?: string; }

async function execute(task: DriveTask, ctx: IExecutionContext): Promise<DriveFileResult | DriveListResult | { content: string }> {
  const token = requireEnv(ctx, "GOOGLE_ACCESS_TOKEN");

  if (task.taskType === "drive.upload") {
    ctx.logger.info("drive.upload", { name: task.name });
    const metadata = { name: task.name, mimeType: task.mimeType ?? "application/octet-stream", ...(task.parentId ? { parents: [task.parentId] } : {}) };
    const boundary = "nexus_drive_boundary";
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${task.mimeType ?? "application/octet-stream"}\r\n\r\n${task.content}\r\n--${boundary}--`;
    const response = await fetch(`${DRIVE_UPLOAD_BASE}/files?uploadType=multipart`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    });
    if (!response.ok) throw new AdapterHttpError("nexus-adapter-drive", response.status, await response.text());
    return response.json() as Promise<DriveFileResult>;
  }

  if (task.taskType === "drive.download") {
    ctx.logger.info("drive.download", { fileId: task.fileId });
    const response = await fetch(`${DRIVE_BASE}/files/${task.fileId}?alt=media`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new AdapterHttpError("nexus-adapter-drive", response.status, await response.text());
    return { content: await response.text() };
  }

  if (task.taskType === "drive.list") {
    ctx.logger.info("drive.list", { folderId: task.folderId });
    const url = new URL(`${DRIVE_BASE}/files`);
    const q: string[] = [];
    if (task.folderId) q.push(`'${task.folderId}' in parents`);
    if (task.mimeType) q.push(`mimeType='${task.mimeType}'`);
    q.push("trashed=false");
    url.searchParams.set("q", q.join(" and "));
    url.searchParams.set("pageSize", String(task.maxResults ?? 50));
    url.searchParams.set("fields", "nextPageToken,files(id,name,mimeType,webViewLink)");
    const response = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new AdapterHttpError("nexus-adapter-drive", response.status, await response.text());
    return response.json() as Promise<DriveListResult>;
  }

  // drive.create-folder
  ctx.logger.info("drive.create-folder", { name: task.name });
  const response = await fetch(`${DRIVE_BASE}/files`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: task.name, mimeType: "application/vnd.google-apps.folder", ...(task.parentId ? { parents: [task.parentId] } : {}) }),
  });
  if (!response.ok) throw new AdapterHttpError("nexus-adapter-drive", response.status, await response.text());
  return response.json() as Promise<DriveFileResult>;
}

export const driveAdapter = defineAdapter<DriveTask, DriveFileResult | DriveListResult | { content: string }>({
  name: "nexus-adapter-drive", version: "0.1.0", capabilities: ["storage.read", "storage.write"],
  taskTypes: ["drive.upload", "drive.download", "drive.list", "drive.create-folder"],
  execute,
});
export default driveAdapter;
