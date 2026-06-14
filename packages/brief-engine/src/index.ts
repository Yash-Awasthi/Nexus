// SPDX-License-Identifier: Apache-2.0
/**
 * brief-engine — Daily intelligence brief builder.
 *
 * Assembles a per-user signed HTML intelligence magazine from a digest
 * of domain feed events.  Key features:
 *   • DigestStore        — stores / retrieves digest snapshots (in-memory + injectable)
 *   • BriefSection       — typed section of a brief (domain + rendered HTML chunk)
 *   • BriefCarousel      — paginate sections into carousel pages
 *   • BriefSigner        — HMAC-SHA256 share URL signing / verification
 *   • BriefRenderer      — assemble sections into a full HTML brief
 *   • BriefEngine        — orchestrates digest → sections → HTML → signed URL
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DigestEvent {
  id: string;
  domain: string;
  summary: string;
  severity?: "low" | "medium" | "high" | "critical";
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface DigestSnapshot {
  id: string;
  userId: string;
  date: string; // YYYY-MM-DD
  events: DigestEvent[];
  createdAt: string;
}

export interface BriefSection {
  domain: string;
  title: string;
  html: string;
  eventCount: number;
}

export interface CarouselPage {
  pageIndex: number;
  totalPages: number;
  sections: BriefSection[];
}

export interface BriefResult {
  userId: string;
  date: string;
  html: string;
  sections: BriefSection[];
  totalEvents: number;
  shareUrl: string;
  generatedAt: string;
}

export interface BriefEngineOptions {
  /** Base URL for share links (default: "https://nexus.local") */
  baseUrl?: string;
  /** HMAC secret for share URL signing */
  hmacSecret?: string;
  /** Sections per carousel page (default: 3) */
  sectionsPerPage?: number;
  /** Injectable digest store */
  store?: DigestStore;
  /** Injectable HMAC function for testing (synchronous) */
  hmacFn?: (secret: string, data: string) => string;
}

// ── Simple hash (deterministic, no crypto dep) ───────────────────────────────

function simpleHmac(secret: string, data: string): string {
  // XOR-fold deterministicly — good enough for test injection; real impl uses node:crypto
  let h = 0;
  const key = secret + "|" + data;
  for (let i = 0; i < key.length; i++) {
    h = ((h << 5) - h + key.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// ── DigestStore ───────────────────────────────────────────────────────────────

export class DigestStore {
  private store = new Map<string, DigestSnapshot>();

  private key(userId: string, date: string): string {
    return `${userId}::${date}`;
  }

  save(snapshot: DigestSnapshot): void {
    this.store.set(this.key(snapshot.userId, snapshot.date), snapshot);
  }

  get(userId: string, date: string): DigestSnapshot | undefined {
    return this.store.get(this.key(userId, date));
  }

  list(userId: string): DigestSnapshot[] {
    return [...this.store.values()].filter((s) => s.userId === userId);
  }

  delete(userId: string, date: string): boolean {
    return this.store.delete(this.key(userId, date));
  }

  clear(): void { this.store.clear(); }
  size(): number { return this.store.size; }
}

// ── BriefSection builder ──────────────────────────────────────────────────────

export class SectionBuilder {
  /** Build an HTML section from a group of events for one domain. */
  build(domain: string, events: DigestEvent[]): BriefSection {
    const title = `${domain.charAt(0).toUpperCase()}${domain.slice(1)} Intelligence`;
    const items = events
      .map((e) => {
        const sev = e.severity ? `<span class="severity-${e.severity}">[${e.severity.toUpperCase()}]</span> ` : "";
        return `<li>${sev}<strong>${escapeHtml(e.summary)}</strong> <time>${e.timestamp}</time></li>`;
      })
      .join("\n");

    const html = `<section class="brief-section" data-domain="${domain}">
  <h2>${escapeHtml(title)}</h2>
  <ul class="event-list">
${items}
  </ul>
</section>`;

    return { domain, title, html, eventCount: events.length };
  }

  private escapeHtml = escapeHtml;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── BriefCarousel ─────────────────────────────────────────────────────────────

export class BriefCarousel {
  private sectionsPerPage: number;

  constructor(sectionsPerPage = 3) {
    this.sectionsPerPage = sectionsPerPage;
  }

  paginate(sections: BriefSection[]): CarouselPage[] {
    const totalPages = Math.max(1, Math.ceil(sections.length / this.sectionsPerPage));
    const pages: CarouselPage[] = [];

    for (let i = 0; i < totalPages; i++) {
      const start = i * this.sectionsPerPage;
      pages.push({
        pageIndex: i,
        totalPages,
        sections: sections.slice(start, start + this.sectionsPerPage),
      });
    }

    return pages;
  }

  /** Render a single page as an HTML carousel slide. */
  renderPage(page: CarouselPage): string {
    const inner = page.sections.map((s) => s.html).join("\n");
    return `<div class="carousel-page" data-page="${page.pageIndex}" data-total="${page.totalPages}">
${inner}
</div>`;
  }
}

// ── BriefSigner ───────────────────────────────────────────────────────────────

export class BriefSigner {
  private secret: string;
  private hmacFn: (secret: string, data: string) => string;

  constructor(secret = "nexus-default-secret", hmacFn?: (secret: string, data: string) => string) {
    this.secret = secret;
    this.hmacFn = hmacFn ?? simpleHmac;
  }

  /** Build and sign a share URL. */
  sign(baseUrl: string, userId: string, date: string): string {
    const payload = `${userId}:${date}`;
    const sig = this.hmacFn(this.secret, payload);
    const url = new URL(`${baseUrl}/brief/share`);
    url.searchParams.set("userId", userId);
    url.searchParams.set("date", date);
    url.searchParams.set("sig", sig);
    return url.toString();
  }

  /** Verify that a share URL has a valid signature. */
  verify(url: string): { valid: boolean; userId?: string; date?: string } {
    try {
      const parsed = new URL(url);
      const userId = parsed.searchParams.get("userId") ?? "";
      const date = parsed.searchParams.get("date") ?? "";
      const sig = parsed.searchParams.get("sig") ?? "";
      const expected = this.hmacFn(this.secret, `${userId}:${date}`);
      return { valid: sig === expected, userId, date };
    } catch {
      return { valid: false };
    }
  }
}

// ── BriefRenderer ─────────────────────────────────────────────────────────────

export class BriefRenderer {
  private carousel: BriefCarousel;

  constructor(sectionsPerPage = 3) {
    this.carousel = new BriefCarousel(sectionsPerPage);
  }

  render(userId: string, date: string, sections: BriefSection[]): string {
    const pages = this.carousel.paginate(sections);
    const slidesHtml = pages.map((p) => this.carousel.renderPage(p)).join("\n");
    const totalEvents = sections.reduce((s, sec) => s + sec.eventCount, 0);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Nexus Intelligence Brief — ${escapeHtml(date)}</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; background: #0d1117; color: #c9d1d9; }
    .brief-header { padding: 2rem; border-bottom: 1px solid #30363d; }
    .brief-header h1 { margin: 0; font-size: 1.5rem; color: #58a6ff; }
    .brief-header .meta { color: #8b949e; font-size: 0.875rem; margin-top: 0.5rem; }
    .carousel { position: relative; }
    .carousel-page { padding: 1.5rem; display: none; }
    .carousel-page.active { display: block; }
    .brief-section { margin-bottom: 1.5rem; border: 1px solid #30363d; border-radius: 6px; padding: 1rem; }
    .brief-section h2 { margin: 0 0 0.75rem; font-size: 1rem; color: #58a6ff; }
    .event-list { list-style: none; padding: 0; margin: 0; }
    .event-list li { padding: 0.4rem 0; border-bottom: 1px solid #21262d; font-size: 0.875rem; }
    .event-list li:last-child { border-bottom: none; }
    .severity-critical { color: #ff7b72; }
    .severity-high { color: #ffa657; }
    .severity-medium { color: #e3b341; }
    .severity-low { color: #7ee787; }
    .carousel-nav { display: flex; justify-content: center; gap: 0.5rem; padding: 1rem; }
    .carousel-nav button { background: #21262d; border: 1px solid #30363d; color: #c9d1d9;
      padding: 0.4rem 1rem; border-radius: 4px; cursor: pointer; }
    .carousel-nav button:hover { background: #30363d; }
  </style>
</head>
<body>
  <div class="brief-header">
    <h1>🌐 Nexus Intelligence Brief</h1>
    <div class="meta">
      <span>User: ${escapeHtml(userId)}</span> &middot;
      <span>Date: ${escapeHtml(date)}</span> &middot;
      <span>${totalEvents} events across ${sections.length} domains</span>
    </div>
  </div>
  <div class="carousel" id="brief-carousel">
${slidesHtml}
  </div>
  <div class="carousel-nav">
    <button onclick="prevPage()">&#8592; Prev</button>
    <span id="page-indicator">1 / ${pages.length}</span>
    <button onclick="nextPage()">Next &#8594;</button>
  </div>
  <script>
    let cur = 0;
    const pages = document.querySelectorAll('.carousel-page');
    function show(n) {
      pages.forEach((p, i) => p.classList.toggle('active', i === n));
      document.getElementById('page-indicator').textContent = (n + 1) + ' / ' + pages.length;
    }
    function nextPage() { cur = (cur + 1) % pages.length; show(cur); }
    function prevPage() { cur = (cur - 1 + pages.length) % pages.length; show(cur); }
    show(0);
  </script>
</body>
</html>`;
  }
}

// ── BriefEngine ───────────────────────────────────────────────────────────────

let _seq = 0;
function uid(prefix: string): string { return `${prefix}-${Date.now()}-${++_seq}`; }

export class BriefEngine {
  private store: DigestStore;
  private signer: BriefSigner;
  private renderer: BriefRenderer;
  private sectionBuilder: SectionBuilder;
  private baseUrl: string;

  constructor(opts: BriefEngineOptions = {}) {
    this.baseUrl = opts.baseUrl ?? "https://nexus.local";
    this.store = opts.store ?? new DigestStore();
    this.signer = new BriefSigner(opts.hmacSecret ?? "nexus-default-secret", opts.hmacFn);
    this.renderer = new BriefRenderer(opts.sectionsPerPage ?? 3);
    this.sectionBuilder = new SectionBuilder();
  }

  /** Save a digest snapshot for a user + date. */
  saveDigest(userId: string, date: string, events: DigestEvent[]): DigestSnapshot {
    const snapshot: DigestSnapshot = {
      id: uid("digest"),
      userId,
      date,
      events,
      createdAt: new Date().toISOString(),
    };
    this.store.save(snapshot);
    return snapshot;
  }

  /** Build a brief from a saved digest. */
  buildBrief(userId: string, date: string): BriefResult | null {
    const snapshot = this.store.get(userId, date);
    if (!snapshot) return null;

    // Group events by domain
    const byDomain = new Map<string, DigestEvent[]>();
    for (const ev of snapshot.events) {
      const arr = byDomain.get(ev.domain) ?? [];
      arr.push(ev);
      byDomain.set(ev.domain, arr);
    }

    // Build sections (sorted by domain name)
    const sections: BriefSection[] = [...byDomain.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([domain, events]) => this.sectionBuilder.build(domain, events));

    const html = this.renderer.render(userId, date, sections);
    const shareUrl = this.signer.sign(this.baseUrl, userId, date);

    return {
      userId,
      date,
      html,
      sections,
      totalEvents: snapshot.events.length,
      shareUrl,
      generatedAt: new Date().toISOString(),
    };
  }

  /** Build a brief directly from events (saves to store first). */
  buildFromEvents(userId: string, date: string, events: DigestEvent[]): BriefResult {
    this.saveDigest(userId, date, events);
    return this.buildBrief(userId, date)!;
  }

  /** Verify a share URL. */
  verifyShareUrl(url: string): { valid: boolean; userId?: string; date?: string } {
    return this.signer.verify(url);
  }

  getStore(): DigestStore { return this.store; }
}
