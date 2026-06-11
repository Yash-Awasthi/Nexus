// SPDX-License-Identifier: Apache-2.0
// @ts-nocheck
import { createReadStream, createWriteStream } from "node:fs";

import { google } from "googleapis";

function driveAuth() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env["GOOGLE_CLIENT_EMAIL"],
      private_key: (process.env["GOOGLE_PRIVATE_KEY"] ?? "").replace(/\\n/g, "\n"),
    },
    scopes: ["https://www.googleapis.com/auth/drive"],
    clientOptions: { subject: process.env["GOOGLE_IMPERSONATE_EMAIL"] },
  });
  return google.drive({ version: "v3", auth });
}

export async function listFiles(
  query?: string,
  maxResults = 30,
): Promise<{ id: string; name: string; mimeType: string; modifiedTime: string }[]> {
  const drive = driveAuth();
  const res = await drive.files.list({
    q: query,
    pageSize: maxResults,
    fields: "files(id,name,mimeType,modifiedTime)",
    orderBy: "modifiedTime desc",
  });
  return (res.data.files ?? []).map((f) => ({
    id: f.id ?? "",
    name: f.name ?? "",
    mimeType: f.mimeType ?? "",
    modifiedTime: f.modifiedTime ?? "",
  }));
}

export async function searchFiles(
  name: string,
): Promise<{ id: string; name: string; mimeType: string }[]> {
  return listFiles(`name contains '${name}'`);
}

export async function uploadFile(
  localPath: string,
  name: string,
  folderId?: string,
): Promise<{ id: string; webViewLink: string }> {
  const drive = driveAuth();
  const res = await drive.files.create({
    requestBody: { name, parents: folderId ? [folderId] : undefined },
    media: { body: createReadStream(localPath) },
    fields: "id,webViewLink",
  });
  return { id: res.data.id ?? "", webViewLink: res.data.webViewLink ?? "" };
}

export async function downloadFile(fileId: string, destPath: string): Promise<void> {
  const drive = driveAuth();
  const res = await drive.files.get({ fileId, alt: "media" }, { responseType: "stream" });
  await new Promise<void>((resolve, reject) => {
    const dest = createWriteStream(destPath);
    (res.data as NodeJS.ReadableStream).pipe(dest);
    dest.on("finish", resolve);
    dest.on("error", reject);
  });
}

export async function shareFile(
  fileId: string,
  email: string,
  role: "reader" | "writer" | "commenter" = "reader",
): Promise<void> {
  const drive = driveAuth();
  await drive.permissions.create({
    fileId,
    requestBody: { type: "user", role, emailAddress: email },
  });
}

export async function createFolder(name: string, parentId?: string): Promise<{ id: string }> {
  const drive = driveAuth();
  const res = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: parentId ? [parentId] : undefined,
    },
    fields: "id",
  });
  return { id: res.data.id ?? "" };
}
