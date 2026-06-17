import { useState, useRef, useCallback, useEffect } from "react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "~/components/ui/dialog";
import {
  Database,
  Plus,
  FileText,
  HardDrive,
  Loader2,
  CheckCircle,
  Upload,
  X,
  Trash2,
  FileCode,
  File,
  FileSpreadsheet,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

// ─── Types ───────────────────────────────────────────────────────────────────

type DocType = "pdf" | "md" | "csv" | "txt" | "docx";

interface KBDocument {
  id: string;
  name: string;
  size: string;
  type: DocType;
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

// ─── Seed Data ────────────────────────────────────────────────────────────────

const SEED_KBS: KnowledgeBase[] = [
  {
    id: "1", name: "Engineering Documentation",
    description: "Internal engineering docs, ADRs, and technical specifications",
    documentCount: 3, totalSize: "1.26 MB", status: "indexed", lastUpdated: "2 hours ago",
    documents: [
      { id: "doc_1", name: "architecture-decisions.md", size: "24 KB",  type: "md"  },
      { id: "doc_2", name: "api-specification.pdf",     size: "1.2 MB", type: "pdf" },
      { id: "doc_3", name: "coding-standards.md",       size: "18 KB",  type: "md"  },
    ],
  },
  {
    id: "2", name: "Product Knowledge Base",
    description: "Product requirements, user research, and feature specifications",
    documentCount: 3, totalSize: "820 KB", status: "indexed", lastUpdated: "1 day ago",
    documents: [
      { id: "doc_4", name: "product-roadmap-2026.pdf", size: "640 KB", type: "pdf" },
      { id: "doc_5", name: "user-research-q1.csv",     size: "128 KB", type: "csv" },
      { id: "doc_6", name: "feature-specs.md",         size: "52 KB",  type: "md"  },
    ],
  },
  {
    id: "3", name: "Security Policies",
    description: "Security policies, compliance documents, and audit reports",
    documentCount: 3, totalSize: "1.5 MB", status: "indexing", lastUpdated: "Just now",
    documents: [
      { id: "doc_7", name: "security-policy-v3.pdf",   size: "890 KB", type: "pdf"  },
      { id: "doc_8", name: "incident-response.docx",   size: "450 KB", type: "docx" },
      { id: "doc_9", name: "audit-checklist.txt",      size: "12 KB",  type: "txt"  },
    ],
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function DocIcon({ type }: { type: DocType }) {
  switch (type) {
    case "pdf":  return <File            className="size-3.5 text-red-400"             />;
    case "md":   return <FileCode        className="size-3.5 text-blue-400"            />;
    case "csv":  return <FileSpreadsheet className="size-3.5 text-green-400"           />;
    case "docx": return <FileText        className="size-3.5 text-sky-400"             />;
    default:     return <FileText        className="size-3.5 text-muted-foreground"    />;
  }
}

const ACCEPTED_EXTS = ".pdf,.docx,.csv,.txt,.md";

function formatFileSize(bytes: number): string {
  if (bytes < 1024)              return bytes + " B";
  if (bytes < 1024 * 1024)      return (bytes / 1024).toFixed(0) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function getDocType(filename: string): DocType {
  const ext = filename.split(".").pop()?.toLowerCase();
  if (ext === "pdf")  return "pdf";
  if (ext === "docx") return "docx";
  if (ext === "csv")  return "csv";
  if (ext === "txt")  return "txt";
  return "md";
}

// ─── KBDetail Component ───────────────────────────────────────────────────────

function KBDetail({
  kb,
  onClose,
  onDocumentDelete,
  onDocumentAdd,
}: {
  kb: KnowledgeBase;
  onClose: () => void;
  onDocumentDelete: (kbId: string, docId: string) => void;
  onDocumentAdd: (kbId: string, doc: KBDocument) => void;
}) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [uploading,  setUploading]  = useState<UploadingFile[]>([]);
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
        [".pdf", ".docx", ".csv", ".txt", ".md"].some((ext) => f.name.toLowerCase().endsWith(ext))
      );

      accepted.forEach((file) => {
        const uploadId  = "upload_" + Date.now() + "_" + Math.random();
        const uploadItem: UploadingFile = { id: uploadId, name: file.name, progress: 0 };
        setUploading((prev) => [...prev, uploadItem]);

        // Upload to backend via FormData
        const formData = new FormData();
        formData.append("file", file);

        const xhr = new XMLHttpRequest();
        xhr.upload.addEventListener("progress", (e) => {
          if (e.lengthComputable) {
            const pct = Math.floor((e.loaded / e.total) * 100);
            setUploading((prev) => prev.map((u) => u.id === uploadId ? { ...u, progress: pct } : u));
          }
        });
        xhr.addEventListener("load", () => {
          const newDoc: KBDocument = {
            id:   "doc_" + Date.now(),
            name: file.name,
            size: formatFileSize(file.size),
            type: getDocType(file.name),
          };
          onDocumentAdd(kb.id, newDoc);
          setUploading((prev) => prev.filter((u) => u.id !== uploadId));
        });
        xhr.addEventListener("error", () => {
          // Fallback: add locally even if upload failed
          const newDoc: KBDocument = {
            id:   "doc_" + Date.now(),
            name: file.name,
            size: formatFileSize(file.size),
            type: getDocType(file.name),
          };
          onDocumentAdd(kb.id, newDoc);
          setUploading((prev) => prev.filter((u) => u.id !== uploadId));
        });
        xhr.open("POST", "/api/kb/" + kb.id + "/documents");
        xhr.send(formData);
      });
    },
    [kb.id, onDocumentAdd]
  );

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files) processFiles(e.dataTransfer.files);
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) { processFiles(e.target.files); e.target.value = ""; }
  };

  return (
    <Card className="border-primary/20 bg-card">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">{kb.name}</CardTitle>
            <CardDescription className="mt-0.5">{kb.description}</CardDescription>
          </div>
          <Button variant="ghost" size="icon" className="size-7" onClick={onClose}><X className="size-4" /></Button>
        </div>
        <div className="flex items-center gap-4 text-xs text-muted-foreground pt-1">
          <span className="flex items-center gap-1"><FileText className="size-3" />{kb.documents.length} document{kb.documents.length !== 1 ? "s" : ""}</span>
          <span className="flex items-center gap-1"><HardDrive className="size-3" />{formatFileSize(totalBytes)}</span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1">
          {kb.documents.map((doc) => (
            <div key={doc.id} className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-muted/50 group transition-colors">
              <DocIcon type={doc.type} />
              <span className="flex-1 text-sm truncate">{doc.name}</span>
              <span className="text-xs text-muted-foreground shrink-0">{doc.size}</span>
              <Badge variant="outline" className="text-[10px] uppercase shrink-0">{doc.type}</Badge>
              <Button
                variant="ghost" size="icon"
                className="size-6 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive transition-all"
                onClick={() => onDocumentDelete(kb.id, doc.id)}
              >
                <Trash2 className="size-3" />
              </Button>
            </div>
          ))}
          {kb.documents.length === 0 && (
            <p className="text-xs text-muted-foreground text-center py-4">No documents yet. Upload files below.</p>
          )}
        </div>

        {uploading.length > 0 && (
          <div className="space-y-2">
            {uploading.map((u) => (
              <div key={u.id} className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="truncate text-muted-foreground">{u.name}</span>
                  <span className="text-muted-foreground shrink-0 ml-2">{u.progress}%</span>
                </div>
                <div className="h-1 rounded-full bg-muted overflow-hidden">
                  <div className="h-full bg-primary rounded-full transition-all duration-150" style={{ width: u.progress + "%" }} />
                </div>
              </div>
            ))}
          </div>
        )}

        <div
          onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
          onDragLeave={() => setIsDragOver(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className={"rounded-xl border-2 border-dashed p-6 text-center cursor-pointer transition-colors " + (isDragOver ? "border-primary bg-primary/5" : "border-border hover:border-primary/50 hover:bg-muted/30")}
        >
          <Upload className={"size-6 mx-auto mb-2 " + (isDragOver ? "text-primary" : "text-muted-foreground")} />
          <p className="text-sm font-medium">{isDragOver ? "Drop files to upload" : "Drop files here or click to browse"}</p>
          <p className="text-xs text-muted-foreground mt-1">PDF, DOCX, CSV, TXT, MD supported</p>
          <input ref={fileInputRef} type="file" accept={ACCEPTED_EXTS} multiple className="hidden" onChange={handleFileInput} />
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function KnowledgeBasesPage() {
  const [kbs,              setKBs]              = useState<KnowledgeBase[]>(SEED_KBS);
  const [selectedKBId,     setSelectedKBId]     = useState<string | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [newKBName,        setNewKBName]        = useState("");
  const [newKBDesc,        setNewKBDesc]        = useState("");
  const [loading,          setLoading]          = useState(true);

  // ── Fetch knowledge bases from backend ────────────────────────────────────
  useEffect(() => {
    fetch("/api/kb?limit=50")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data) => {
        const list: KnowledgeBase[] = Array.isArray(data) ? data : (data?.kbs ?? data?.knowledgeBases ?? []);
        if (list.length > 0) setKBs(list);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleKBClick = (kbId: string) => {
    setSelectedKBId((prev) => (prev === kbId ? null : kbId));
  };

  const handleDocumentDelete = (kbId: string, docId: string) => {
    setKBs((prev) =>
      prev.map((kb) => {
        if (kb.id !== kbId) return kb;
        const newDocs = kb.documents.filter((d) => d.id !== docId);
        return { ...kb, documents: newDocs, documentCount: newDocs.length };
      })
    );
    fetch("/api/kb/" + kbId + "/documents/" + docId, { method: "DELETE" }).catch(() => {});
  };

  const handleDocumentAdd = (kbId: string, doc: KBDocument) => {
    setKBs((prev) =>
      prev.map((kb) => {
        if (kb.id !== kbId) return kb;
        const newDocs = [...kb.documents, doc];
        return { ...kb, documents: newDocs, documentCount: newDocs.length };
      })
    );
  };

  const handleCreateKB = () => {
    if (!newKBName.trim()) return;
    const payload = { name: newKBName.trim(), description: newKBDesc.trim() || "No description provided" };

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

    // Persist to backend, update id from response
    fetch("/api/kb", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((created: KnowledgeBase) => {
        if (created?.id) {
          setKBs((prev) => prev.map((kb) => (kb.id === optimistic.id ? { ...kb, id: created.id } : kb)));
        }
      })
      .catch(() => {});
  };

  const selectedKB = kbs.find((kb) => kb.id === selectedKBId);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-6xl mx-auto p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Database className="size-6 text-muted-foreground" />
            <div>
              <h1 className="text-xl font-semibold">Knowledge Bases</h1>
              <p className="text-sm text-muted-foreground">Manage document collections for retrieval-augmented generation</p>
            </div>
          </div>
          <Button size="sm" className="gap-2" onClick={() => setCreateDialogOpen(true)}>
            <Plus className="size-3.5" />
            New Knowledge Base
          </Button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {kbs.map((kb) => {
              const isSelected = selectedKBId === kb.id;
              return (
                <Card
                  key={kb.id}
                  onClick={() => handleKBClick(kb.id)}
                  className={"cursor-pointer transition-all " + (isSelected ? "ring-2 ring-primary" : "hover:ring-2 hover:ring-primary/20")}
                >
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-sm">{kb.name}</CardTitle>
                      <div className="flex items-center gap-1">
                        {kb.status === "indexed" ? (
                          <Badge variant="outline" className="text-[10px] text-green-400">
                            <CheckCircle className="size-2.5 mr-1" />Indexed
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px] text-yellow-400">
                            <Loader2 className="size-2.5 mr-1 animate-spin" />Indexing
                          </Badge>
                        )}
                        {isSelected ? <ChevronUp className="size-3.5 text-muted-foreground ml-1" /> : <ChevronDown className="size-3.5 text-muted-foreground ml-1" />}
                      </div>
                    </div>
                    <CardDescription>{kb.description}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-center gap-4 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1"><FileText className="size-3" />{kb.documents.length} docs</span>
                      <span className="flex items-center gap-1"><HardDrive className="size-3" />{kb.totalSize}</span>
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
          />
        )}
      </div>

      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Create Knowledge Base</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Name</label>
              <Input placeholder="e.g. Engineering Documentation" value={newKBName} onChange={(e) => setNewKBName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleCreateKB()} />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Description</label>
              <Input placeholder="Brief description of this knowledge base" value={newKBDesc} onChange={(e) => setNewKBDesc(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleCreateKB} disabled={!newKBName.trim()}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
