// SPDX-License-Identifier: Apache-2.0
/**
 * wiki — Collaborative wiki system for the Nexus platform.
 *
 * Provides:
 *   • WikiPage          — versioned page with git-backed diffs
 *   • WikiAcl           — per-page ACL (owner/editor/viewer)
 *   • WikiComment       — threaded page comments
 *   • WikiDraft         — auto-saved page drafts
 *   • WikiSearch        — full-text search across pages + comments
 *   • WikiNotifier      — change notification queue
 *   • WikiStore         — central store wiring all components
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type PageStatus = "published" | "draft" | "archived" | "deleted";
export type AclRole = "owner" | "editor" | "viewer";
export type NotificationEvent = "page_created" | "page_updated" | "comment_added" | "page_deleted" | "draft_saved";

export interface WikiPageVersion {
  version: number;
  content: string;
  editedBy: string;
  editedAt: string;
  summary: string;
  diff?: string; // unified diff from previous version
}

export interface WikiPage {
  id: string;
  slug: string;
  title: string;
  content: string;
  status: PageStatus;
  tags: string[];
  linkedRepos: string[];
  templateId?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  history: WikiPageVersion[];
  starred: string[]; // user IDs who starred
}

export interface AclEntry {
  userId: string;
  role: AclRole;
  grantedBy: string;
  grantedAt: string;
}

export interface WikiComment {
  id: string;
  pageId: string;
  parentId?: string; // threaded replies
  authorId: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  resolved: boolean;
}

export interface WikiDraft {
  id: string;
  pageId?: string; // undefined = new page draft
  authorId: string;
  title: string;
  content: string;
  savedAt: string;
}

export interface WikiNotification {
  id: string;
  event: NotificationEvent;
  pageId: string;
  actorId: string;
  recipientIds: string[];
  payload: Record<string, unknown>;
  createdAt: string;
  read: boolean;
}

// ── ID util ───────────────────────────────────────────────────────────────────

let _seq = 0;
function uid(prefix: string) { return `${prefix}-${Date.now()}-${++_seq}`; }

// ── Diff util (unified diff — pure text, no external dep) ────────────────────

function computeDiff(oldText: string, newText: string): string {
  if (oldText === newText) return "";
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const removed = oldLines.filter((l) => !newLines.includes(l)).map((l) => `- ${l}`);
  const added = newLines.filter((l) => !oldLines.includes(l)).map((l) => `+ ${l}`);
  return [...removed, ...added].join("\n");
}

// ── WikiAcl ───────────────────────────────────────────────────────────────────

export class WikiAcl {
  private entries = new Map<string, Map<string, AclEntry>>(); // pageId → userId → entry

  grant(pageId: string, userId: string, role: AclRole, grantedBy: string): AclEntry {
    if (!this.entries.has(pageId)) this.entries.set(pageId, new Map());
    const entry: AclEntry = { userId, role, grantedBy, grantedAt: new Date().toISOString() };
    this.entries.get(pageId)!.set(userId, entry);
    return entry;
  }

  revoke(pageId: string, userId: string): boolean {
    return this.entries.get(pageId)?.delete(userId) ?? false;
  }

  getRole(pageId: string, userId: string): AclRole | null {
    return this.entries.get(pageId)?.get(userId)?.role ?? null;
  }

  canRead(pageId: string, userId: string): boolean {
    const role = this.getRole(pageId, userId);
    return role !== null;
  }

  canEdit(pageId: string, userId: string): boolean {
    const role = this.getRole(pageId, userId);
    return role === "owner" || role === "editor";
  }

  canAdmin(pageId: string, userId: string): boolean {
    return this.getRole(pageId, userId) === "owner";
  }

  listEntries(pageId: string): AclEntry[] {
    return [...(this.entries.get(pageId)?.values() ?? [])];
  }
}

// ── WikiPage store ────────────────────────────────────────────────────────────

export interface CreatePageInput {
  slug: string;
  title: string;
  content: string;
  createdBy: string;
  tags?: string[];
  linkedRepos?: string[];
  templateId?: string;
  status?: PageStatus;
}

export interface UpdatePageInput {
  title?: string;
  content?: string;
  tags?: string[];
  linkedRepos?: string[];
  status?: PageStatus;
  editedBy: string;
  summary?: string;
}

export class WikiPageStore {
  private pages = new Map<string, WikiPage>();
  private slugIndex = new Map<string, string>(); // slug → id

  create(input: CreatePageInput): WikiPage {
    if (this.slugIndex.has(input.slug)) {
      throw new Error(`Slug already exists: ${input.slug}`);
    }
    const now = new Date().toISOString();
    const page: WikiPage = {
      id: uid("wp"),
      slug: input.slug,
      title: input.title,
      content: input.content,
      status: input.status ?? "published",
      tags: input.tags ? [...new Set(input.tags)] : [],
      linkedRepos: input.linkedRepos ?? [],
      templateId: input.templateId,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
      version: 1,
      history: [{
        version: 1,
        content: input.content,
        editedBy: input.createdBy,
        editedAt: now,
        summary: "Initial version",
      }],
      starred: [],
    };
    this.pages.set(page.id, page);
    this.slugIndex.set(page.slug, page.id);
    return page;
  }

  get(id: string): WikiPage | undefined { return this.pages.get(id); }
  getBySlug(slug: string): WikiPage | undefined {
    const id = this.slugIndex.get(slug);
    return id ? this.pages.get(id) : undefined;
  }

  update(id: string, input: UpdatePageInput): WikiPage | undefined {
    const page = this.pages.get(id);
    if (!page) return undefined;

    const oldContent = page.content;
    const now = new Date().toISOString();
    const newVersion = page.version + 1;

    const updated: WikiPage = {
      ...page,
      title: input.title ?? page.title,
      content: input.content ?? page.content,
      tags: input.tags ? [...new Set(input.tags)] : page.tags,
      linkedRepos: input.linkedRepos ?? page.linkedRepos,
      status: input.status ?? page.status,
      updatedAt: now,
      version: newVersion,
      history: [
        ...page.history,
        {
          version: newVersion,
          content: input.content ?? page.content,
          editedBy: input.editedBy,
          editedAt: now,
          summary: input.summary ?? `Updated by ${input.editedBy}`,
          diff: input.content ? computeDiff(oldContent, input.content) : undefined,
        },
      ],
    };
    this.pages.set(id, updated);
    return updated;
  }

  delete(id: string): boolean {
    const page = this.pages.get(id);
    if (!page) return false;
    this.slugIndex.delete(page.slug);
    return this.pages.delete(id);
  }

  softDelete(id: string): WikiPage | undefined {
    return this.update(id, { status: "deleted", editedBy: "system", summary: "Soft deleted" });
  }

  star(id: string, userId: string): boolean {
    const page = this.pages.get(id);
    if (!page) return false;
    if (!page.starred.includes(userId)) page.starred.push(userId);
    return true;
  }

  unstar(id: string, userId: string): boolean {
    const page = this.pages.get(id);
    if (!page) return false;
    const idx = page.starred.indexOf(userId);
    if (idx >= 0) page.starred.splice(idx, 1);
    return true;
  }

  list(filter?: { status?: PageStatus; tag?: string; createdBy?: string }): WikiPage[] {
    let pages = [...this.pages.values()];
    if (filter?.status) pages = pages.filter((p) => p.status === filter.status);
    if (filter?.tag) pages = pages.filter((p) => p.tags.includes(filter.tag!));
    if (filter?.createdBy) pages = pages.filter((p) => p.createdBy === filter.createdBy);
    return pages.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  count(): number { return this.pages.size; }
}

// ── WikiComment ───────────────────────────────────────────────────────────────

export class WikiCommentStore {
  private comments = new Map<string, WikiComment>();

  add(pageId: string, authorId: string, content: string, parentId?: string): WikiComment {
    const now = new Date().toISOString();
    const comment: WikiComment = {
      id: uid("wc"),
      pageId,
      parentId,
      authorId,
      content,
      createdAt: now,
      updatedAt: now,
      resolved: false,
    };
    this.comments.set(comment.id, comment);
    return comment;
  }

  get(id: string): WikiComment | undefined { return this.comments.get(id); }

  update(id: string, content: string): WikiComment | undefined {
    const c = this.comments.get(id);
    if (!c) return undefined;
    c.content = content;
    c.updatedAt = new Date().toISOString();
    return c;
  }

  resolve(id: string): boolean {
    const c = this.comments.get(id);
    if (!c) return false;
    c.resolved = true;
    return true;
  }

  delete(id: string): boolean { return this.comments.delete(id); }

  listForPage(pageId: string): WikiComment[] {
    return [...this.comments.values()]
      .filter((c) => c.pageId === pageId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  threadFor(commentId: string): WikiComment[] {
    const root = this.comments.get(commentId);
    if (!root) return [];
    return [root, ...[...this.comments.values()].filter((c) => c.parentId === commentId)];
  }
}

// ── WikiDraft ─────────────────────────────────────────────────────────────────

export class WikiDraftStore {
  private drafts = new Map<string, WikiDraft>();

  save(authorId: string, title: string, content: string, pageId?: string): WikiDraft {
    // one draft per author+pageId (or author for new pages)
    const key = `${authorId}::${pageId ?? "new"}`;
    const existing = [...this.drafts.values()].find((d) => d.authorId === authorId && d.pageId === pageId);
    const draft: WikiDraft = {
      id: existing?.id ?? uid("wd"),
      pageId,
      authorId,
      title,
      content,
      savedAt: new Date().toISOString(),
    };
    if (existing) {
      this.drafts.set(existing.id, draft);
    } else {
      void key;
      this.drafts.set(draft.id, draft);
    }
    return draft;
  }

  get(id: string): WikiDraft | undefined { return this.drafts.get(id); }

  getDraftFor(authorId: string, pageId?: string): WikiDraft | undefined {
    return [...this.drafts.values()].find((d) => d.authorId === authorId && d.pageId === pageId);
  }

  delete(id: string): boolean { return this.drafts.delete(id); }

  listFor(authorId: string): WikiDraft[] {
    return [...this.drafts.values()].filter((d) => d.authorId === authorId);
  }
}

// ── WikiSearch ────────────────────────────────────────────────────────────────

export interface SearchHit {
  type: "page" | "comment";
  id: string;
  title?: string;
  snippet: string;
  score: number;
}

export class WikiSearch {
  search(query: string, pages: WikiPage[], comments: WikiComment[]): SearchHit[] {
    const q = query.toLowerCase();
    const hits: SearchHit[] = [];

    for (const page of pages) {
      if (page.status === "deleted") continue;
      const haystack = `${page.title} ${page.content} ${page.tags.join(" ")}`.toLowerCase();
      const count = (haystack.match(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length;
      if (count > 0) {
        const idx = haystack.indexOf(q);
        const snippet = page.content.slice(Math.max(0, idx - 40), idx + 100).trim();
        hits.push({ type: "page", id: page.id, title: page.title, snippet, score: count * 2 });
      }
    }

    for (const comment of comments) {
      const hay = comment.content.toLowerCase();
      const count = (hay.match(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length;
      if (count > 0) {
        hits.push({ type: "comment", id: comment.id, snippet: comment.content.slice(0, 120), score: count });
      }
    }

    return hits.sort((a, b) => b.score - a.score);
  }
}

// ── WikiNotifier ──────────────────────────────────────────────────────────────

export class WikiNotifier {
  private notifications: WikiNotification[] = [];
  private subscribers = new Map<string, Set<string>>(); // pageId → userIds

  subscribe(pageId: string, userId: string): void {
    if (!this.subscribers.has(pageId)) this.subscribers.set(pageId, new Set());
    this.subscribers.get(pageId)!.add(userId);
  }

  unsubscribe(pageId: string, userId: string): void {
    this.subscribers.get(pageId)?.delete(userId);
  }

  emit(event: NotificationEvent, pageId: string, actorId: string, payload: Record<string, unknown> = {}): WikiNotification {
    const recipientIds = [
      ...(this.subscribers.get(pageId) ?? []),
    ].filter((uid) => uid !== actorId);

    const notif: WikiNotification = {
      id: uid("wn"),
      event,
      pageId,
      actorId,
      recipientIds,
      payload,
      createdAt: new Date().toISOString(),
      read: false,
    };
    this.notifications.push(notif);
    return notif;
  }

  getForUser(userId: string): WikiNotification[] {
    return this.notifications
      .filter((n) => n.recipientIds.includes(userId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  markRead(notificationId: string): boolean {
    const n = this.notifications.find((x) => x.id === notificationId);
    if (!n) return false;
    n.read = true;
    return true;
  }

  unreadCount(userId: string): number {
    return this.notifications.filter((n) => n.recipientIds.includes(userId) && !n.read).length;
  }
}

// ── WikiStore — facade ────────────────────────────────────────────────────────

export class WikiStore {
  readonly pages: WikiPageStore;
  readonly acl: WikiAcl;
  readonly comments: WikiCommentStore;
  readonly drafts: WikiDraftStore;
  readonly search: WikiSearch;
  readonly notifier: WikiNotifier;

  constructor() {
    this.pages = new WikiPageStore();
    this.acl = new WikiAcl();
    this.comments = new WikiCommentStore();
    this.drafts = new WikiDraftStore();
    this.search = new WikiSearch();
    this.notifier = new WikiNotifier();
  }

  /** Create a page and set the creator as owner. */
  createPage(input: CreatePageInput): WikiPage {
    const page = this.pages.create(input);
    this.acl.grant(page.id, input.createdBy, "owner", input.createdBy);
    this.notifier.emit("page_created", page.id, input.createdBy, { title: page.title });
    return page;
  }

  /** Update a page if the editor has permission. */
  updatePage(id: string, input: UpdatePageInput): WikiPage | undefined {
    if (!this.acl.canEdit(id, input.editedBy)) return undefined;
    const page = this.pages.update(id, input);
    if (page) this.notifier.emit("page_updated", page.id, input.editedBy, { version: page.version });
    return page;
  }

  /** Full-text search across pages and comments. */
  query(q: string): SearchHit[] {
    return this.search.search(q, this.pages.list(), [
      ...this.pages.list().flatMap((p) => this.comments.listForPage(p.id)),
    ]);
  }
}
