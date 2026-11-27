// SPDX-License-Identifier: Apache-2.0
import React, { useState, useRef, useEffect } from "react";

interface AttachedFile {
  id: string;
  filename: string;
  size: number;
  added_at: string;
  content?: string;
}

interface ProjectFileAttachmentsProps {
  projectId: string;
}

const MAX_FILES = 10;
const MAX_SIZE = 5 * 1024 * 1024; // 5 MB
const ACCEPTED = [
  ".txt",
  ".md",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".json",
  ".yaml",
  ".yml",
  ".pdf",
  ".csv",
];

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

interface ServerFile {
  id: string;
  name: string;
  size: number;
  createdAt: string;
}

const fromServer = (f: ServerFile): AttachedFile => ({
  id: f.id,
  filename: f.name,
  size: f.size,
  added_at: f.createdAt,
});

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

const FILE_ICONS: Record<string, string> = {
  ts: "🔷",
  tsx: "🔷",
  js: "🟡",
  jsx: "🟡",
  py: "🐍",
  json: "📋",
  md: "📝",
  txt: "📄",
  pdf: "📕",
  yaml: "⚙️",
  yml: "⚙️",
  csv: "📊",
};

function fileIcon(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return FILE_ICONS[ext] ?? "📄";
}

export function ProjectFileAttachments({ projectId }: ProjectFileAttachmentsProps) {
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch(`/api/v1/projects/${projectId}/files`)
      .then((r) => (r.ok ? r.json() : { files: [] }))
      .then((d: { files?: ServerFile[] }) => setFiles((d.files ?? []).map(fromServer)))
      .catch(() => setFiles([]));
  }, [projectId]);

  async function addFiles(fileList: File[]) {
    setError(null);
    let count = files.length;
    for (const f of fileList) {
      if (count >= MAX_FILES) {
        setError(`Max ${MAX_FILES} files per project`);
        break;
      }
      if (f.size > MAX_SIZE) {
        setError(`"${f.name}" exceeds 5 MB limit`);
        continue;
      }
      const ext = "." + (f.name.split(".").pop()?.toLowerCase() ?? "");
      if (!ACCEPTED.includes(ext)) {
        setError(`"${f.name}" — unsupported type`);
        continue;
      }
      try {
        const res = await fetch(`/api/v1/projects/${projectId}/files`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: f.name,
            content: await toBase64(f),
            mimeType: f.type || undefined,
          }),
        });
        if (!res.ok) throw new Error(String(res.status));
        const saved = fromServer((await res.json()) as ServerFile);
        count += 1;
        setFiles((prev) => [...prev, saved]);
      } catch {
        setError(`"${f.name}" could not be uploaded`);
      }
    }
  }

  async function removeFile(id: string) {
    const res = await fetch(`/api/v1/projects/${projectId}/files/${id}`, {
      method: "DELETE",
    }).catch(() => null);
    if (res?.ok) setFiles((prev) => prev.filter((f) => f.id !== id));
    else setError("Could not remove file");
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    addFiles(Array.from(e.dataTransfer.files));
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "var(--background)",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "10px 14px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <span
          style={{
            fontSize: 11,
            color: "var(--muted-foreground)",
            textTransform: "uppercase",
            letterSpacing: "1px",
          }}
        >
          Files ({files.length}/{MAX_FILES})
        </span>
        <button
          onClick={() => inputRef.current?.click()}
          style={{
            fontSize: 11,
            color: "var(--primary)",
            background: "none",
            border: "1px solid var(--primary)",
            borderRadius: 4,
            padding: "2px 8px",
            cursor: "pointer",
          }}
        >
          + Add
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPTED.join(",")}
          style={{ display: "none" }}
          onChange={(e) => {
            if (e.target.files) addFiles(Array.from(e.target.files));
            e.target.value = "";
          }}
        />
      </div>

      {/* Error */}
      {error && (
        <div
          style={{
            margin: "8px 14px",
            padding: "6px 10px",
            background: "var(--destructive-surface)",
            border: "1px solid var(--destructive)",
            borderRadius: 5,
            fontSize: 11,
            color: "var(--destructive)",
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          {error}
          <span
            onClick={() => setError(null)}
            style={{ cursor: "pointer", color: "var(--destructive)" }}
          >
            ×
          </span>
        </div>
      )}

      {/* File list */}
      <div style={{ flex: 1, overflowY: "auto", padding: "8px 0" }}>
        {files.length === 0 ? (
          /* Drop zone */
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            onClick={() => inputRef.current?.click()}
            style={{
              margin: "12px 14px",
              border: `2px dashed ${dragging ? "var(--primary)" : "var(--border)"}`,
              borderRadius: 8,
              background: dragging ? "var(--accent)" : "var(--card)",
              padding: "28px 16px",
              textAlign: "center",
              cursor: "pointer",
              transition: "all 0.15s",
            }}
          >
            <div style={{ fontSize: 20, marginBottom: 8 }}>📂</div>
            <div style={{ fontSize: 12, color: "var(--muted-foreground)" }}>
              Drop files here or click to browse
            </div>
            <div style={{ fontSize: 10, color: "var(--muted-foreground)", marginTop: 4 }}>
              {ACCEPTED.join("  ")}
            </div>
          </div>
        ) : (
          <>
            {files.map((f) => (
              <div
                key={f.id}
                onMouseEnter={() => setHoveredId(f.id)}
                onMouseLeave={() => setHoveredId(null)}
                style={{
                  padding: "7px 14px",
                  borderBottom: "1px solid var(--secondary)",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  background: hoveredId === f.id ? "var(--secondary)" : "transparent",
                }}
              >
                <span style={{ fontSize: 14, flexShrink: 0 }}>{fileIcon(f.filename)}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 12,
                      color: "var(--foreground)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {f.filename}
                  </div>
                  <div style={{ fontSize: 10, color: "var(--muted-foreground)", marginTop: 1 }}>
                    {formatSize(f.size)} · {formatDate(f.added_at)}
                  </div>
                </div>
                {hoveredId === f.id && (
                  <span
                    onClick={() => removeFile(f.id)}
                    style={{
                      color: "var(--destructive)",
                      cursor: "pointer",
                      fontSize: 14,
                      flexShrink: 0,
                      padding: "0 2px",
                    }}
                  >
                    ×
                  </span>
                )}
              </div>
            ))}
            {/* Drop more zone */}
            {files.length < MAX_FILES && (
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
                style={{
                  margin: "8px 14px",
                  border: `1px dashed ${dragging ? "var(--primary)" : "var(--border)"}`,
                  borderRadius: 6,
                  padding: "8px",
                  textAlign: "center",
                  fontSize: 11,
                  color: "var(--muted-foreground)",
                  cursor: "default",
                  transition: "all 0.15s",
                }}
              >
                Drop more files here
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
