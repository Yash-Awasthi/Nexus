// SPDX-License-Identifier: Apache-2.0
import { useState, useEffect } from "react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "~/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import {
  Wrench,
  Search,
  Code,
  Plus,
  Upload,
  Download,
  ChevronDown,
  Copy,
  Check,
  FileJson,
  FileText,
  Loader2,
  Trash2,
} from "lucide-react";

interface Skill {
  id: string;
  name: string;
  description: string;
  language: "Python" | "TypeScript" | "JavaScript";
  tags: string[];
  code: string;
}

// ── API helpers ────────────────────────────────────────────────────────────
async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { message?: string }).message ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

interface BackendSkill {
  id: string;
  name: string;
  description: string;
  code: string;
  language: string;
  version: string;
  parameters: Record<string, unknown>;
  createdAt: string;
}

function normalizeLanguage(lang: string): Skill["language"] {
  const map: Record<string, Skill["language"]> = {
    python: "Python",
    typescript: "TypeScript",
    javascript: "JavaScript",
  };
  return map[lang.toLowerCase()] ?? "Python";
}

function toSkill(b: BackendSkill): Skill {
  return {
    id: b.id,
    name: b.name,
    description: b.description,
    language: normalizeLanguage(b.language),
    tags: [],
    code: b.code,
  };
}

// Keep a handful of offline examples shown when the user has no skills yet
const EXAMPLE_SKILLS: Skill[] = [
  {
    id: "sk_1",
    name: "Web Scraper",
    description: "Extract structured data from web pages using CSS selectors and XPath",
    language: "Python",
    tags: ["scraping", "data"],
    code: `import requests
from bs4 import BeautifulSoup
from typing import Optional
import time

def scrape_page(url: str, selector: str, delay: float = 1.0) -> list[str]:
    """
    Extract text content from a web page using a CSS selector.

    Args:
        url: The URL to scrape
        selector: CSS selector to target elements
        delay: Seconds to wait between requests (rate limiting)

    Returns:
        List of text strings from matching elements
    """
    headers = {
        "User-Agent": "Mozilla/5.0 (compatible; Scraper/1.0)"
    }
    resp = requests.get(url, headers=headers, timeout=10)
    resp.raise_for_status()

    soup = BeautifulSoup(resp.text, "html.parser")
    elements = soup.select(selector)
    results = [el.get_text(strip=True) for el in elements if el.get_text(strip=True)]

    time.sleep(delay)
    return results


def scrape_links(url: str, base_url: Optional[str] = None) -> list[dict]:
    """Extract all hyperlinks from a page with optional base URL resolution."""
    resp = requests.get(url, timeout=10)
    soup = BeautifulSoup(resp.text, "html.parser")
    links = []
    for a in soup.find_all("a", href=True):
        href = a["href"]
        if base_url and href.startswith("/"):
            href = base_url.rstrip("/") + href
        links.append({"text": a.get_text(strip=True), "href": href})
    return links`,
  },
  {
    id: "sk_2",
    name: "JSON Transformer",
    description: "Transform JSON data between different schemas using JMESPath expressions",
    language: "TypeScript",
    tags: ["data", "transform"],
    code: `import jmespath from "jmespath";

export interface TransformResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * Transform data using a JMESPath expression.
 * Returns a typed result with success/error discriminant.
 */
export function transform<T = unknown>(
  data: unknown,
  expression: string
): TransformResult<T> {
  try {
    const result = jmespath.search(data, expression);
    return { success: true, data: result as T };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

/** Apply multiple transformations in sequence */
export function pipeline<T = unknown>(
  data: unknown,
  expressions: string[]
): TransformResult<T> {
  let current: unknown = data;
  for (const expr of expressions) {
    const result = transform(current, expr);
    if (!result.success) return result as TransformResult<T>;
    current = result.data;
  }
  return { success: true, data: current as T };
}

/** Validate that all required keys exist in transformed output */
export function validateKeys(data: unknown, required: string[]): string[] {
  if (typeof data !== "object" || data === null) return required;
  const missing = required.filter((key) => !(key in (data as object)));
  return missing;
}`,
  },
  {
    id: "sk_3",
    name: "PDF Parser",
    description: "Extract text and metadata from PDF documents",
    language: "Python",
    tags: ["documents", "parsing"],
    code: `import PyPDF2
from pathlib import Path
from dataclasses import dataclass

@dataclass
class PDFContent:
    text: str
    page_count: int
    metadata: dict

def extract_text(pdf_path: str) -> str:
    reader = PyPDF2.PdfReader(pdf_path)
    return '\\n'.join(page.extract_text() for page in reader.pages)`,
  },
  {
    id: "sk_4",
    name: "API Client Generator",
    description: "Generate typed API client code from OpenAPI specifications",
    language: "TypeScript",
    tags: ["api", "codegen"],
    code: `import { generateClient } from "./codegen";

export async function generateFromSpec(specUrl: string) {
  const spec = await fetch(specUrl).then((r) => r.json());
  return generateClient(spec);
}`,
  },
  {
    id: "sk_5",
    name: "SQL Query Builder",
    description: "Build parameterized SQL queries with a fluent API",
    language: "TypeScript",
    tags: ["database", "sql"],
    code: `type OrderDirection = "ASC" | "DESC";
type JoinType = "INNER" | "LEFT" | "RIGHT" | "FULL";

interface QueryState {
  selects: string[];
  table: string;
  joins: string[];
  conditions: string[];
  groupBys: string[];
  orderBys: string[];
  limitVal?: number;
  offsetVal?: number;
}

export class QueryBuilder {
  private state: QueryState = {
    selects: [],
    table: "",
    joins: [],
    conditions: [],
    groupBys: [],
    orderBys: [],
  };

  select(...cols: string[]): this {
    this.state.selects.push(...cols);
    return this;
  }

  from(table: string): this {
    this.state.table = table;
    return this;
  }

  join(table: string, on: string, type: JoinType = "INNER"): this {
    this.state.joins.push(\`\${type} JOIN \${table} ON \${on}\`);
    return this;
  }

  where(condition: string): this {
    this.state.conditions.push(condition);
    return this;
  }

  groupBy(...cols: string[]): this {
    this.state.groupBys.push(...cols);
    return this;
  }

  orderBy(col: string, dir: OrderDirection = "ASC"): this {
    this.state.orderBys.push(\`\${col} \${dir}\`);
    return this;
  }

  limit(n: number): this {
    this.state.limitVal = n;
    return this;
  }

  offset(n: number): this {
    this.state.offsetVal = n;
    return this;
  }

  build(): string {
    const parts: string[] = [];
    const cols = this.state.selects.length ? this.state.selects.join(", ") : "*";
    parts.push(\`SELECT \${cols} FROM \${this.state.table}\`);
    if (this.state.joins.length) parts.push(this.state.joins.join(" "));
    if (this.state.conditions.length) parts.push(\`WHERE \${this.state.conditions.join(" AND ")}\`);
    if (this.state.groupBys.length) parts.push(\`GROUP BY \${this.state.groupBys.join(", ")}\`);
    if (this.state.orderBys.length) parts.push(\`ORDER BY \${this.state.orderBys.join(", ")}\`);
    if (this.state.limitVal != null) parts.push(\`LIMIT \${this.state.limitVal}\`);
    if (this.state.offsetVal != null) parts.push(\`OFFSET \${this.state.offsetVal}\`);
    return parts.join(" ");
  }
}`,
  },
  {
    id: "sk_6",
    name: "Image Analyzer",
    description: "Analyze images using computer vision for object detection and classification",
    language: "Python",
    tags: ["vision", "ai"],
    code: `from PIL import Image
import torch
from transformers import pipeline

def analyze_image(image_path: str) -> dict:
    classifier = pipeline("image-classification")
    image = Image.open(image_path)
    return classifier(image)`,
  },
  {
    id: "sk_7",
    name: "Rate Limiter",
    description: "Token-bucket rate limiter for API request throttling with burst support",
    language: "TypeScript",
    tags: ["api", "performance", "throttle"],
    code: `interface RateLimiterOptions {
  /** Maximum tokens in the bucket */
  capacity: number;
  /** Tokens refilled per second */
  refillRate: number;
  /** Initial tokens (defaults to capacity) */
  initialTokens?: number;
}

/**
 * Token-bucket rate limiter.
 * Allows burst traffic up to \`capacity\` then throttles to \`refillRate\` req/s.
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly capacity: number;
  private readonly refillRate: number;

  constructor(options: RateLimiterOptions) {
    this.capacity = options.capacity;
    this.refillRate = options.refillRate;
    this.tokens = options.initialTokens ?? options.capacity;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }

  /** Returns true and consumes a token if allowed, false otherwise */
  tryConsume(tokens = 1): boolean {
    this.refill();
    if (this.tokens >= tokens) {
      this.tokens -= tokens;
      return true;
    }
    return false;
  }

  /** Returns ms to wait before the next request is allowed */
  msUntilNext(tokens = 1): number {
    this.refill();
    if (this.tokens >= tokens) return 0;
    return Math.ceil(((tokens - this.tokens) / this.refillRate) * 1000);
  }

  /** Wrap an async function with rate limiting */
  async throttle<T>(fn: () => Promise<T>): Promise<T> {
    const wait = this.msUntilNext();
    if (wait > 0) {
      await new Promise((r) => setTimeout(r, wait));
    }
    this.tryConsume();
    return fn();
  }
}`,
  },
  {
    id: "sk_8",
    name: "CSV Processor",
    description:
      "Parse, filter, transform, and export CSV data with streaming support for large files",
    language: "Python",
    tags: ["data", "csv", "etl"],
    code: `import csv
import io
from typing import Callable, Iterator, Any
from dataclasses import dataclass


@dataclass
class CSVStats:
    row_count: int
    column_count: int
    columns: list[str]
    null_counts: dict[str, int]


def read_csv(path: str, encoding: str = "utf-8") -> list[dict[str, str]]:
    """Read a CSV file into a list of dicts."""
    with open(path, newline="", encoding=encoding) as f:
        return list(csv.DictReader(f))


def stream_csv(path: str, chunk_size: int = 1000) -> Iterator[list[dict]]:
    """Stream a large CSV in chunks to avoid memory issues."""
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        chunk: list[dict] = []
        for row in reader:
            chunk.append(dict(row))
            if len(chunk) >= chunk_size:
                yield chunk
                chunk = []
        if chunk:
            yield chunk


def filter_rows(
    rows: list[dict],
    predicate: Callable[[dict], bool],
) -> list[dict]:
    """Filter rows by a predicate function."""
    return [row for row in rows if predicate(row)]


def transform_column(
    rows: list[dict],
    column: str,
    fn: Callable[[str], Any],
) -> list[dict]:
    """Apply a transformation function to a single column."""
    return [{**row, column: fn(row[column])} for row in rows if column in row]


def get_stats(rows: list[dict]) -> CSVStats:
    """Compute basic statistics for the CSV dataset."""
    if not rows:
        return CSVStats(0, 0, [], {})
    columns = list(rows[0].keys())
    null_counts = {col: sum(1 for r in rows if not r.get(col)) for col in columns}
    return CSVStats(
        row_count=len(rows),
        column_count=len(columns),
        columns=columns,
        null_counts=null_counts,
    )


def write_csv(rows: list[dict], path: str) -> None:
    """Write a list of dicts to a CSV file."""
    if not rows:
        return
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=rows[0].keys())
        writer.writeheader()
        writer.writerows(rows)


def to_csv_string(rows: list[dict]) -> str:
    """Serialize rows to a CSV string (useful for in-memory export)."""
    if not rows:
        return ""
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=rows[0].keys())
    writer.writeheader()
    writer.writerows(rows)
    return buf.getvalue()`,
  },
];

// ─────────────────────────────────────────────────────────────────────────────

const languageColors: Record<Skill["language"], string> = {
  Python: "text-blue-400 border-blue-400/30 bg-blue-400/10",
  TypeScript: "text-sky-400 border-sky-400/30 bg-sky-400/10",
  JavaScript: "text-yellow-400 border-yellow-400/30 bg-yellow-400/10",
};

interface AddSkillForm {
  name: string;
  description: string;
  language: Skill["language"] | "";
  tags: string;
  code: string;
}

// ─── Code Viewer with line numbers and copy ───────────────────────────────────

function CodeViewer({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const lines = code.split("\n");

  const handleCopy = () => {
    navigator.clipboard.writeText(code).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="rounded-md bg-zinc-950 border border-zinc-800 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-zinc-800 bg-zinc-900/60">
        <span className="text-[10px] text-zinc-500 font-mono">{lines.length} lines</span>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs gap-1 text-zinc-400 hover:text-zinc-100"
          onClick={handleCopy}
        >
          {copied ? (
            <>
              <Check className="size-3 text-green-400" />
              <span className="text-green-400">Copied!</span>
            </>
          ) : (
            <>
              <Copy className="size-3" />
              Copy
            </>
          )}
        </Button>
      </div>
      <div className="overflow-auto max-h-96">
        <table className="w-full text-xs font-mono leading-relaxed">
          <tbody>
            {lines.map((line, i) => (
              <tr key={i} className="hover:bg-zinc-900/40">
                <td className="select-none text-right pr-3 pl-3 py-0 text-zinc-600 w-8 min-w-[2.5rem]">
                  {i + 1}
                </td>
                <td className="pr-4 py-0 text-zinc-100 whitespace-pre">{line || "\u00a0"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Import Dialog (real file reading) ─────────────────────────────────────────

function ImportDialog({
  open,
  onOpenChange,
  onImport,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onImport: (skill: Skill) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const [importing, setImporting] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useState<HTMLInputElement | null>(null);

  const processFile = (file: File) => {
    setFileName(file.name);
    setImporting(true);
    setError(null);

    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const content = ev.target?.result as string;
        if (file.name.endsWith(".json")) {
          const data = JSON.parse(content);
          const newSkill: Skill = {
            id: `sk_import_${Date.now()}`,
            name: data.name || file.name.replace(/\.\w+$/, ""),
            description: data.description || "Imported skill",
            language: data.language || "Python",
            tags: Array.isArray(data.tags) ? data.tags : ["imported"],
            code: data.code || content,
          };
          onImport(newSkill);
          onOpenChange(false);
        } else if (file.name.endsWith(".yaml") || file.name.endsWith(".yml")) {
          // Simple YAML key-value parsing
          const lines = content.split("\n");
          const parsed: Record<string, string> = {};
          let codeLines: string[] = [];
          let inCode = false;

          for (const line of lines) {
            if (inCode) {
              if (line.startsWith("  ")) {
                codeLines.push(line.slice(2));
              } else if (line.trim() === "") {
                codeLines.push("");
              } else {
                inCode = false;
              }
            }
            const match = line.match(/^(\w+):\s*(.+)/);
            if (match) {
              const key = match[1];
              let val = match[2].replace(/^["']|["']$/g, "");
              parsed[key] = val;
            }
            if (line.match(/^code:\s*\|/)) {
              inCode = true;
            }
          }

          const newSkill: Skill = {
            id: `sk_import_${Date.now()}`,
            name: parsed.name || file.name.replace(/\.\w+$/, ""),
            description: parsed.description || "Imported skill",
            language: (parsed.language as Skill["language"]) || "Python",
            tags: parsed.tags
              ? parsed.tags
                  .replace(/[\[\]]/g, "")
                  .split(",")
                  .map((t) => t.trim().replace(/^["']|["']$/g, ""))
                  .filter(Boolean)
              : ["imported"],
            code: codeLines.length > 0 ? codeLines.join("\n") : content,
          };
          onImport(newSkill);
          onOpenChange(false);
        } else {
          // Plain text / code file - treat as code
          const newSkill: Skill = {
            id: `sk_import_${Date.now()}`,
            name: file.name.replace(/\.\w+$/, ""),
            description: "Imported from file",
            language:
              file.name.endsWith(".ts") || file.name.endsWith(".tsx")
                ? "TypeScript"
                : file.name.endsWith(".js") || file.name.endsWith(".jsx")
                  ? "JavaScript"
                  : "Python",
            tags: ["imported"],
            code: content,
          };
          onImport(newSkill);
          onOpenChange(false);
        }
      } catch (err) {
        setError(`Failed to parse file: ${err instanceof Error ? err.message : "Unknown error"}`);
      }
      setImporting(false);
      setFileName(null);
    };
    reader.onerror = () => {
      setError("Failed to read file");
      setImporting(false);
      setFileName(null);
    };
    reader.readAsText(file);
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="size-4" />
            Import Skill
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <p className="text-sm text-muted-foreground">
            Import a skill from a JSON, YAML, or code file.
          </p>

          {error && (
            <div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md px-3 py-2">
              {error}
            </div>
          )}

          {/* Hidden file input */}
          <input
            type="file"
            accept=".json,.yaml,.yml,.py,.ts,.tsx,.js,.jsx,.txt"
            className="hidden"
            id="skill-file-input"
            onChange={handleFileInput}
          />

          {/* Drop zone */}
          <div
            className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors cursor-pointer ${
              dragging
                ? "border-primary bg-primary/5"
                : "border-border hover:border-primary/50 hover:bg-muted/30"
            }`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const file = e.dataTransfer.files[0];
              if (file) processFile(file);
            }}
            onClick={() => {
              document.getElementById("skill-file-input")?.click();
            }}
          >
            {importing ? (
              <div className="flex flex-col items-center gap-2">
                <Loader2 className="size-8 text-primary animate-spin" />
                <p className="text-sm text-muted-foreground">Importing {fileName}...</p>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2">
                <Upload className="size-8 text-muted-foreground" />
                <p className="text-sm font-medium">Drop a file here or click to browse</p>
                <p className="text-xs text-muted-foreground">
                  Supports .json, .yaml, .py, .ts, .js files
                </p>
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────────

export default function SkillsPage() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [addLoading, setAddLoading] = useState(false);
  const [addForm, setAddForm] = useState<AddSkillForm>({
    name: "",
    description: "",
    language: "",
    tags: "",
    code: "",
  });

  // ── Load skills from API ─────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiFetch<{ skills: BackendSkill[] }>("/api/skills")
      .then(({ skills: list }) => {
        if (!cancelled) {
          setSkills(list.length > 0 ? list.map(toSkill) : EXAMPLE_SKILLS);
        }
      })
      .catch(() => {
        // Fall back to examples on auth/network error
        if (!cancelled) setSkills(EXAMPLE_SKILLS);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = skills.filter(
    (s) =>
      s.name.toLowerCase().includes(search.toLowerCase()) ||
      s.description.toLowerCase().includes(search.toLowerCase()) ||
      s.tags.some((t) => t.toLowerCase().includes(search.toLowerCase())),
  );

  const handleAddSkill = async () => {
    if (!addForm.name || !addForm.language) return;
    setAddLoading(true);
    try {
      const created = await apiFetch<BackendSkill>("/api/skills", {
        method: "POST",
        body: JSON.stringify({
          name: addForm.name,
          description: addForm.description || "No description",
          language: addForm.language.toLowerCase(),
          code: addForm.code || "# No code provided",
        }),
      });
      setSkills((prev) => [toSkill(created), ...prev]);
      setAddOpen(false);
      setAddForm({ name: "", description: "", language: "", tags: "", code: "" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create skill");
    } finally {
      setAddLoading(false);
    }
  };

  const handleDeleteSkill = async (id: string) => {
    if (!confirm("Delete this skill?")) return;
    try {
      await apiFetch(`/api/skills/${id}`, { method: "DELETE" });
      setSkills((prev) => prev.filter((s) => s.id !== id));
      if (selectedSkill?.id === id) setSelectedSkill(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete skill");
    }
  };

  const handleImportSkill = async (skill: Skill) => {
    try {
      const created = await apiFetch<BackendSkill>("/api/skills", {
        method: "POST",
        body: JSON.stringify({
          name: skill.name,
          description: skill.description,
          language: skill.language.toLowerCase(),
          code: skill.code,
        }),
      });
      setSkills((prev) => [toSkill(created), ...prev]);
    } catch {
      // If API fails, still show it locally
      setSkills((prev) => [skill, ...prev]);
    }
  };

  const handleExport = (skill: Skill, format: "json" | "yaml") => {
    if (format === "json") {
      const blob = new Blob([JSON.stringify(skill, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${skill.name.toLowerCase().replace(/\s+/g, "-")}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } else {
      // Simple YAML serialization
      const yaml = [
        `name: "${skill.name}"`,
        `description: "${skill.description}"`,
        `language: ${skill.language}`,
        `tags: [${skill.tags.map((t) => `"${t}"`).join(", ")}]`,
        `code: |`,
        ...skill.code.split("\n").map((l) => `  ${l}`),
      ].join("\n");
      const blob = new Blob([yaml], { type: "text/yaml" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${skill.name.toLowerCase().replace(/\s+/g, "-")}.yaml`;
      a.click();
      URL.revokeObjectURL(url);
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {error && (
        <div className="fixed top-4 right-4 z-50 bg-destructive text-destructive-foreground text-xs px-3 py-2 rounded-md shadow-lg flex items-center gap-2">
          {error}
          <button onClick={() => setError(null)} className="font-bold">
            ✕
          </button>
        </div>
      )}
      <div className="max-w-6xl mx-auto p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Wrench className="size-6 text-muted-foreground" />
            <div>
              <h1 className="text-xl font-semibold">Skills</h1>
              <p className="text-sm text-muted-foreground">
                Reusable code snippets and functions available to AI agents
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="gap-2"
              onClick={() => setImportOpen(true)}
            >
              <Upload className="size-4" />
              Import
            </Button>
            <Button size="sm" className="gap-2" onClick={() => setAddOpen(true)}>
              <Plus className="size-4" />
              Add Skill
            </Button>
          </div>
        </div>

        {/* Search */}
        <div className="relative max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            placeholder="Search skills..."
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {/* Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((skill) => (
            <Card
              key={skill.id}
              className="cursor-pointer hover:ring-2 hover:ring-primary/20 transition-all"
            >
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-sm">{skill.name}</CardTitle>
                  <Badge
                    variant="outline"
                    className={`text-[10px] shrink-0 ${languageColors[skill.language]}`}
                  >
                    {skill.language}
                  </Badge>
                </div>
                <CardDescription className="text-xs">{skill.description}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap gap-1">
                  {skill.tags.map((tag) => (
                    <Badge key={tag} variant="secondary" className="text-[10px]">
                      {tag}
                    </Badge>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex-1 gap-2 text-xs"
                    onClick={() => setSelectedSkill(skill)}
                  >
                    <Code className="size-3" />
                    View Code
                  </Button>
                  {/* Export dropdown */}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 px-2 gap-1 text-xs"
                        title="Export skill"
                      >
                        <Download className="size-3" />
                        <ChevronDown className="size-3" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        className="text-xs gap-2"
                        onClick={() => handleExport(skill, "json")}
                      >
                        <FileJson className="size-3.5" />
                        Export as JSON
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="text-xs gap-2"
                        onClick={() => handleExport(skill, "yaml")}
                      >
                        <FileText className="size-3.5" />
                        Export as YAML
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="text-xs gap-2 text-destructive focus:text-destructive"
                        onClick={() => handleDeleteSkill(skill.id)}
                      >
                        <Trash2 className="size-3.5" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {filtered.length === 0 && (
          <div className="text-center py-12 text-muted-foreground text-sm">
            No skills match your search.
          </div>
        )}
      </div>

      {/* View Code Dialog */}
      <Dialog open={!!selectedSkill} onOpenChange={(open) => !open && setSelectedSkill(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Code className="size-4" />
              {selectedSkill?.name}
              {selectedSkill && (
                <Badge
                  variant="outline"
                  className={`text-[10px] ml-2 ${languageColors[selectedSkill.language]}`}
                >
                  {selectedSkill.language}
                </Badge>
              )}
            </DialogTitle>
          </DialogHeader>
          {selectedSkill && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">{selectedSkill.description}</p>
              <div className="flex flex-wrap gap-1 mb-1">
                {selectedSkill.tags.map((tag) => (
                  <Badge key={tag} variant="secondary" className="text-[10px]">
                    {tag}
                  </Badge>
                ))}
              </div>
              <CodeViewer code={selectedSkill.code} />
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Add Skill Dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Plus className="size-4" />
              Add Skill
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="sk-name">Name</Label>
              <Input
                id="sk-name"
                placeholder="My Skill"
                value={addForm.name}
                onChange={(e) => setAddForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="sk-description">Description</Label>
              <Input
                id="sk-description"
                placeholder="What does this skill do?"
                value={addForm.description}
                onChange={(e) => setAddForm((f) => ({ ...f, description: e.target.value }))}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="sk-language">Language</Label>
              <Select
                value={addForm.language}
                onValueChange={(v) =>
                  setAddForm((f) => ({ ...f, language: v as Skill["language"] }))
                }
              >
                <SelectTrigger id="sk-language">
                  <SelectValue placeholder="Select language..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Python">Python</SelectItem>
                  <SelectItem value="TypeScript">TypeScript</SelectItem>
                  <SelectItem value="JavaScript">JavaScript</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="sk-tags">Tags</Label>
              <Input
                id="sk-tags"
                placeholder="e.g. data, api, transform (comma-separated)"
                value={addForm.tags}
                onChange={(e) => setAddForm((f) => ({ ...f, tags: e.target.value }))}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="sk-code">Code</Label>
              <Textarea
                id="sk-code"
                placeholder={`def my_skill():\n    pass`}
                className="min-h-[160px] font-mono text-xs leading-relaxed"
                value={addForm.code}
                onChange={(e) => setAddForm((f) => ({ ...f, code: e.target.value }))}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleAddSkill}
              disabled={!addForm.name || !addForm.language || addLoading}
              className="gap-2"
            >
              {addLoading ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Adding...
                </>
              ) : (
                <>
                  <Plus className="size-4" />
                  Add Skill
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Import Dialog */}
      <ImportDialog open={importOpen} onOpenChange={setImportOpen} onImport={handleImportSkill} />
    </div>
  );
}
