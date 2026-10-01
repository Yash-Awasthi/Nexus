// SPDX-License-Identifier: Apache-2.0
import {
  Database,
  Plus,
  FileText,
  HardDrive,
  Loader2,
  CheckCircle,
  Upload,
  Globe,
  X,
  Trash2,
  FileCode,
  File,
  FileSpreadsheet,
  ChevronDown,
  ChevronUp,
  Network,
  Search,
} from "lucide-react";
import { useState, useRef, useCallback, useEffect } from "react";
import { Link } from "react-router";

import { Page, PageHeader } from "~/components/page";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";

// ─── Types ───────────────────────────────────────────────────────────────────

type DocType = "pdf" | "md" | "csv" | "txt" | "docx";

interface KBDocument {
  id: string;
  name: string;
  size: string;
  type: DocType;
  docClass?: string;
  tags?: string[];
}

interface KnowledgeBase {
  id: string;
  name: string;
  description: string;
  documentCount: number;
  totalSize: string;
  status: "indexed" | "indexing";
  lastUpdated: string;
  documents: KBDocument[];
}

interface UploadingFile {
  id: string;
  name: string;
  progress: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface ApiKB {
  id: string;
  name: string;
  description?: string;
  docCount?: number;
  createdAt?: string;
  documents?: KBDocument[];
}

function normalizeKB(raw: ApiKB): KnowledgeBase {
  const documents = raw.documents ?? [];
  const totalBytes = documents.reduce((sum, d) => {
    const [num, unit] = d.size.split(" ");
    const n = parseFloat(num);
    if (unit === "KB") return sum + n * 1024;
    if (unit === "MB") return sum + n * 1024 * 1024;
    return sum + n;
  }, 0);
  return {
    id: raw.id,
    name: raw.name,
    description: raw.description || "No description provided",
    documentCount: raw.docCount ?? documents.length,
    totalSize: totalBytes ? formatFileSize(totalBytes) : "0 KB",
    status: "indexed",
    lastUpdated: raw.createdAt ? new Date(raw.createdAt).toLocaleString() : "",
    documents,
  };
}

function DocIcon({ type }: { type: DocType }) {
  switch (type) {
    case "pdf":
      return <File className="size-3.5 text-destructive" />;
    case "md":
      return <FileCode className="size-3.5 text-primary" />;
    case "csv":
      return <FileSpreadsheet className="size-3.5 text-success" />;
    case "docx":
      return <FileText className="size-3.5 text-primary" />;
    default:
      return <FileText className="size-3.5 text-muted-foreground" />;
  }
}

// Images are read by OCR on the server.
const ACCEPTED_EXTS = ".pdf,.docx,.csv,.txt,.md,.png,.jpg,.jpeg,.webp";

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

// ─── KBDetail Component ───────────────────────────────────────────────────────

function KBDetail({
  kb,
  onClose,
  onDocumentDelete,
  onDocumentAdd,
  onDocumentsSet,
}: {
  kb: KnowledgeBase;
  onClose: () => void;
  onDocumentDelete: (kbId: string, docId: string) => void;
  onDocumentAdd: (kbId: string, doc: KBDocument) => void;
  onDocumentsSet: (kbId: string, docs: KBDocument[]) => void;
}) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [siteUrl, setSiteUrl] = useState("");
  const [importing, setImporting] = useState(false);
  const [importNote, setImportNote] = useState("");
  const [uploading, setUploading] = useState<UploadingFile[]>([]);
  const [uploadError, setUploadError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const totalBytes = kb.documents.reduce((sum, d) => {
    const [num, unit] = d.size.split(" ");
    const n = parseFloat(num);
    if (unit === "KB") return sum + n * 1024;
    if (unit === "MB") return sum + n * 1024 * 1024;
    return sum + n;
  }, 0);

  const processFiles = useCallback(
    (files: FileList | File[]) => {
      const accepted = Array.from(files).filter((f) =>
        ACCEPTED_EXTS.split(",").some((ext) => f.name.toLowerCase().endsWith(ext)),
      );

      accepted.forEach((file) => {
        const uploadId = "upload_" + Date.now() + "_" + Math.random();
        const uploadItem: UploadingFile = { id: uploadId, name: file.name, progress: 0 };
        setUploading((prev) => [...prev, uploadItem]);

        setUploadError("");
        file
          .arrayBuffer()
          .then((buf) => {
            let binary = "";
            const bytes = new Uint8Array(buf);
            for (let i = 0; i < bytes.length; i += 0x8000) {
              binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
            }
            return fetch("/api/kb/" + kb.id + "/documents", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name: file.name, contentBase64: btoa(binary) }),
            });
          })
          .then(async (r) => {
            const d = (await r.json().catch(() => null)) as
              (KBDocument & { error?: string }) | null;
            if (!r.ok || !d) throw new Error(d?.error ?? `Upload failed (${r.status})`);
            onDocumentAdd(kb.id, d);
          })
          .catch((e: unknown) =>
            setUploadError(`${file.name}: ${e instanceof Error ? e.message : String(e)}`),
          )
          .finally(() => setUploading((prev) => prev.filter((u) => u.id !== uploadId)));
      });
    },
    [kb.id, onDocumentAdd],
  );

  const importWebsite = async () => {
    const url = siteUrl.trim();
    if (!url) return;
    setImporting(true);
    setImportNote("");
    setUploadError("");
    try {
      const r = await fetch("/api/kb/" + kb.id + "/crawl", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, maxPages: 15 }),
      });
      const d = (await r.json().catch(() => null)) as {
        added?: number;
        disallowed?: number;
        error?: string;
      } | null;
      if (!r.ok || !d) throw new Error(d?.error ?? `Import failed (${r.status})`);
      const list = await fetch("/api/kb/" + kb.id + "/documents");
      const docs = (await list.json().catch(() => null)) as { documents?: KBDocument[] } | null;
      if (docs?.documents) onDocumentsSet(kb.id, docs.documents);
      setImportNote(
        `Imported ${d.added ?? 0} page${d.added === 1 ? "" : "s"}` +
          (d.disallowed ? `; robots.txt kept out ${d.disallowed}.` : "."),
      );
      setSiteUrl("");
    } catch (e: unknown) {
      setUploadError(`${url}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setImporting(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files) processFiles(e.dataTransfer.files);
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      processFiles(e.target.files);
      e.target.value = "";
    }
  };

  return (
    <Card className="border-primary/20 bg-card">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">{kb.name}</CardTitle>
            <CardDescription className="mt-0.5">{kb.description}</CardDescription>
          </div>
          <Button variant="ghost" size="icon" className="size-7" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
        <div className="flex items-center gap-4 text-xs text-muted-foreground pt-1">
          <span className="flex items-center gap-1">
            <FileText className="size-3" />
            {kb.documents.length} document{kb.documents.length !== 1 ? "s" : ""}
          </span>
          <span className="flex items-center gap-1">
            <HardDrive className="size-3" />
            {formatFileSize(totalBytes)}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1">
          {kb.documents.map((doc) => (
            <div
              key={doc.id}
              className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-muted/50 group transition-colors"
            >
              <DocIcon type={doc.type} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{doc.name}</p>
                {doc.docClass && doc.docClass !== "other" && (
                  <p className="truncate text-[11px] text-muted-foreground">
                    {[doc.docClass, ...(doc.tags ?? []).filter((t) => t !== doc.docClass)].join(
                      " · ",
                    )}
                  </p>
                )}
              </div>
              <span className="text-xs text-muted-foreground shrink-0">{doc.size}</span>
              <Badge variant="outline" className="text-[10px] uppercase shrink-0">
                {doc.type}
              </Badge>
              <Button
                variant="ghost"
                size="icon"
                className="size-6 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive transition-all"
                onClick={() => onDocumentDelete(kb.id, doc.id)}
              >
                <Trash2 className="size-3" />
              </Button>
            </div>
          ))}
          {kb.documents.length === 0 && (
            <p className="text-xs text-muted-foreground text-center py-4">
              No documents yet. Upload files below, then mention this knowledge base with @kb: in
              chat.
            </p>
          )}
        </div>

        {kb.documents.length > 0 && <KBSearch kbId={kb.id} />}
        {kb.documents.length > 0 && <KBGraph kbId={kb.id} />}

        {uploadError && <p className="text-xs text-destructive">{uploadError}</p>}
        {importNote && <p className="text-xs text-muted-foreground">{importNote}</p>}

        {uploading.length > 0 && (
          <div className="space-y-2">
            {uploading.map((u) => (
              <div key={u.id} className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="truncate text-muted-foreground">{u.name}</span>
                  <span className="text-muted-foreground shrink-0 ml-2">{u.progress}%</span>
                </div>
                <div className="h-1 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full bg-primary rounded-full transition-all duration-150"
                    style={{ width: u.progress + "%" }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}

        <div
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragOver(true);
          }}
          onDragLeave={() => setIsDragOver(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className={
            "rounded-xl border-2 border-dashed p-6 text-center cursor-pointer transition-colors " +
            (isDragOver
              ? "border-primary bg-primary/5"
              : "border-border hover:border-primary/50 hover:bg-muted/30")
          }
        >
          <Upload
            className={
              "size-6 mx-auto mb-2 " + (isDragOver ? "text-primary" : "text-muted-foreground")
            }
          />
          <p className="text-sm font-medium">
            {isDragOver ? "Drop files to upload" : "Drop files here or click to browse"}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            PDF, DOCX, CSV, TXT, MD and images (read by OCR)
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_EXTS}
            multiple
            className="hidden"
            onChange={handleFileInput}
          />
        </div>

        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            void importWebsite();
          }}
        >
          <Input
            type="url"
            inputMode="url"
            aria-label="Website to import"
            placeholder="https://docs.example.com"
            value={siteUrl}
            onChange={(e) => setSiteUrl(e.target.value)}
            disabled={importing}
            className="min-w-0 flex-1"
          />
          <Button type="submit" variant="outline" disabled={importing || !siteUrl.trim()}>
            {importing ? <Loader2 className="size-4 animate-spin" /> : <Globe className="size-4" />}
            Import website
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

const GRAPH_ENTITY_TYPES = [
  ["PERSON", "People"],
  ["ORG", "Organisations"],
  ["LOCATION", "Places"],
  ["PRODUCT", "Products"],
  ["EVENT", "Events"],
  ["DATE", "Dates"],
  ["OTHER", "Other"],
] as const;

interface GraphJob {
  state: "idle" | "running" | "done" | "error";
  chunksDone?: number;
  chunksTotal?: number;
  of?: number;
  entities?: number;
  relationships?: number;
  failed?: number;
  error?: string;
}

/** Reads the base's chunks into the knowledge graph, keeping the entity kinds switched on. */
function KBGraph({ kbId }: { kbId: string }) {
  const [off, setOff] = useState<string[]>([]);
  const [job, setJob] = useState<GraphJob>({ state: "idle" });
  const [error, setError] = useState("");

  const poll = useCallback(async () => {
    const r = await fetch(`/api/kb/${kbId}/graph`);
    if (r.ok) setJob((await r.json()) as GraphJob);
  }, [kbId]);

  // Pick up a build that was started before this page was opened, and follow it to the end.
  useEffect(() => {
    void poll().catch(() => undefined);
  }, [poll]);
  useEffect(() => {
    if (job.state !== "running") return;
    const timer = setInterval(() => void poll().catch(() => undefined), 2000);
    return () => clearInterval(timer);
  }, [job.state, poll]);

  const build = async () => {
    setError("");
    try {
      const entityTypes = GRAPH_ENTITY_TYPES.map(([t]) => t).filter((t) => !off.includes(t));
      const r = await fetch(`/api/kb/${kbId}/graph`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(off.length ? { entityTypes } : {}),
      });
      const body = (await r.json().catch(() => ({}))) as GraphJob & { message?: string };
      if (!r.ok) throw new Error(body.message ?? body.error ?? `Build failed (${r.status})`);
      setJob(body);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const running = job.state === "running";
  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          <Network className="size-4 text-muted-foreground" /> Knowledge graph
        </p>
        <Button size="sm" variant="outline" onClick={() => void build()} disabled={running}>
          {running && <Loader2 className="size-4 animate-spin" />}
          Build graph
        </Button>
      </div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Entities to keep">
        {GRAPH_ENTITY_TYPES.map(([type, label]) => {
          const on = !off.includes(type);
          return (
            <button
              key={type}
              type="button"
              aria-pressed={on}
              onClick={() => setOff((o) => (on ? [...o, type] : o.filter((t) => t !== type)))}
              className={
                "rounded-full border px-2.5 py-0.5 text-xs transition-colors " +
                (on ? "border-primary/40 bg-primary/10" : "text-muted-foreground line-through")
              }
            >
              {label}
            </button>
          );
        })}
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {running && (
        <p className="text-xs text-muted-foreground" role="status">
          Reading chunk {job.chunksDone ?? 0} of {job.chunksTotal}. This can take a few minutes; you
          will get a notification when it finishes.
        </p>
      )}
      {job.state === "error" && <p className="text-xs text-destructive">{job.error}</p>}
      {job.state === "done" && (
        <p className="text-xs text-muted-foreground">
          {job.entities
            ? `Read ${job.chunksTotal} of ${job.of} chunks: ${job.entities} entities and ${job.relationships} relationships.`
            : `Read ${job.chunksTotal} chunks and found no entities. Check that your default model answers.`}
          {job.failed ? ` ${job.failed} chunks failed.` : ""}{" "}
          <Link to="/knowledge-graph" className="underline underline-offset-2">
            Open the graph
          </Link>
        </p>
      )}
    </div>
  );
}

interface SearchHit {
  id: string;
  docName: string;
  text: string;
  score: number;
}

function KBSearch({ kbId }: { kbId: string }) {
  const [query, setQuery] = useState("");
  const [split, setSplit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ subQuestions?: string[]; results: SearchHit[] } | null>(
    null,
  );

  const search = async () => {
    setBusy(true);
    setError("");
    try {
      const params = new URLSearchParams({ q: query.trim(), limit: "5" });
      if (split) params.set("decompose", "1");
      const r = await fetch(`/api/kb/${kbId}/search?${params}`);
      const body = (await r.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
        subQuestions?: string[];
        results?: SearchHit[];
      };
      if (!r.ok) throw new Error(body.message ?? body.error ?? `Search failed (${r.status})`);
      setResult({ subQuestions: body.subQuestions, results: body.results ?? [] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  return (
    <div className="space-y-3">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (query.trim()) void search();
        }}
      >
        <Input
          aria-label="Search this knowledge base"
          placeholder="Ask this knowledge base…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="min-w-0 flex-1"
        />
        <Button
          type="submit"
          variant="outline"
          disabled={busy || !query.trim()}
          aria-label="Search"
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
        </Button>
      </form>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <Switch checked={split} onCheckedChange={setSplit} size="sm" />
        Split a multi-part question into sub-questions (uses your default model)
      </label>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {result && (
        <div className="space-y-2">
          {result.subQuestions && result.subQuestions.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
              {result.subQuestions.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          )}
          {result.results.length === 0 ? (
            <p className="text-xs text-muted-foreground">Nothing in this knowledge base matches.</p>
          ) : (
            result.results.map((h) => (
              <div key={h.id} className="rounded-lg bg-muted/40 px-3 py-2">
                <p className="text-xs font-medium break-words">{h.docName}</p>
                <p className="line-clamp-3 text-xs text-muted-foreground break-words">{h.text}</p>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function KnowledgeBasesPage() {
  const [kbs, setKBs] = useState<KnowledgeBase[]>([]);
  const [selectedKBId, setSelectedKBId] = useState<string | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [newKBName, setNewKBName] = useState("");
  const [newKBDesc, setNewKBDesc] = useState("");
  const [loading, setLoading] = useState(true);

  // ── Fetch knowledge bases from backend ────────────────────────────────────
  const loadKBs = useCallback(() => {
    return fetch("/api/kb?limit=50")
      .then((r) => (r.ok ? (r.json() as Promise<{ kbs?: ApiKB[] }>) : Promise.reject()))
      .then((data) => setKBs((data.kbs ?? []).map(normalizeKB)))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadKBs();
  }, [loadKBs]);

  const handleKBClick = (kbId: string) => {
    setSelectedKBId((prev) => (prev === kbId ? null : kbId));
  };

  const handleDocumentDelete = (kbId: string, docId: string) => {
    setKBs((prev) =>
      prev.map((kb) => {
        if (kb.id !== kbId) return kb;
        const newDocs = kb.documents.filter((d) => d.id !== docId);
        return { ...kb, documents: newDocs, documentCount: newDocs.length };
      }),
    );
    fetch("/api/kb/" + kbId + "/documents/" + docId, { method: "DELETE" }).catch(() => {});
  };

  const handleDocumentAdd = (kbId: string, doc: KBDocument) => {
    setKBs((prev) =>
      prev.map((kb) => {
        if (kb.id !== kbId) return kb;
        const newDocs = [...kb.documents, doc];
        return { ...kb, documents: newDocs, documentCount: newDocs.length };
      }),
    );
  };

  const handleDocumentsSet = (kbId: string, docs: KBDocument[]) => {
    setKBs((prev) =>
      prev.map((kb) =>
        kb.id === kbId ? { ...kb, documents: docs, documentCount: docs.length } : kb,
      ),
    );
  };

  const handleCreateKB = () => {
    if (!newKBName.trim()) return;
    const payload = {
      name: newKBName.trim(),
      description: newKBDesc.trim() || "No description provided",
    };

    // Optimistic add
    const optimistic: KnowledgeBase = {
      id: "kb_" + Date.now(),
      ...payload,
      documentCount: 0,
      totalSize: "0 KB",
      status: "indexed",
      lastUpdated: "Just now",
      documents: [],
    };
    setKBs((prev) => [...prev, optimistic]);
    setNewKBName("");
    setNewKBDesc("");
    setCreateDialogOpen(false);

    // Persist to backend, then reload the real list (ids come from the server)
    fetch("/api/kb", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(() => loadKBs())
      .catch(() => {});
  };

  const selectedKB = kbs.find((kb) => kb.id === selectedKBId);

  return (
    <Page width="wide">
      <PageHeader
        title="Knowledge bases"
        description="Document collections the council and your agents can search. Mention one in a question with @kb:."
        actions={
          <Button onClick={() => setCreateDialogOpen(true)}>
            <Plus /> New knowledge base
          </Button>
        }
      />

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : kbs.length === 0 ? (
        <Card className="py-12">
          <CardContent className="flex flex-col items-center gap-2 text-center">
            <Database className="size-8 text-muted-foreground" />
            <p className="text-sm font-medium">No knowledge bases yet</p>
            <p className="text-xs text-muted-foreground max-w-sm">
              Create a knowledge base to start collecting documents for retrieval-augmented
              generation.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {kbs.map((kb) => {
            const isSelected = selectedKBId === kb.id;
            return (
              <Card
                key={kb.id}
                onClick={() => handleKBClick(kb.id)}
                className={
                  "cursor-pointer transition-all " +
                  (isSelected ? "ring-2 ring-primary" : "hover:ring-2 hover:ring-primary/20")
                }
              >
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm">{kb.name}</CardTitle>
                    <div className="flex items-center gap-1">
                      {kb.status === "indexed" ? (
                        <Badge variant="outline" className="text-[10px] text-success">
                          <CheckCircle className="size-2.5 mr-1" />
                          Indexed
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-[10px] text-warning">
                          <Loader2 className="size-2.5 mr-1 animate-spin" />
                          Indexing
                        </Badge>
                      )}
                      {isSelected ? (
                        <ChevronUp className="size-3.5 text-muted-foreground ml-1" />
                      ) : (
                        <ChevronDown className="size-3.5 text-muted-foreground ml-1" />
                      )}
                    </div>
                  </div>
                  <CardDescription>{kb.description}</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center gap-4 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <FileText className="size-3" />
                      {kb.documents.length} docs
                    </span>
                    <span className="flex items-center gap-1">
                      <HardDrive className="size-3" />
                      {kb.totalSize}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-2">Updated {kb.lastUpdated}</p>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {selectedKB && (
        <KBDetail
          kb={selectedKB}
          onClose={() => setSelectedKBId(null)}
          onDocumentDelete={handleDocumentDelete}
          onDocumentAdd={handleDocumentAdd}
          onDocumentsSet={handleDocumentsSet}
        />
      )}

      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Knowledge Base</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Name</label>
              <Input
                placeholder="e.g. Engineering Documentation"
                value={newKBName}
                onChange={(e) => setNewKBName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleCreateKB()}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Description</label>
              <Input
                placeholder="Brief description of this knowledge base"
                value={newKBDesc}
                onChange={(e) => setNewKBDesc(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreateKB} disabled={!newKBName.trim()}>
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Page>
  );
}
