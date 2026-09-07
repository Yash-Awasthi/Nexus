// SPDX-License-Identifier: Apache-2.0
/**
 * @nexus/spider — session pool + anti-bot heuristics.
 *
 * Faithful port of Crawlee's `SessionPool` / `Session` model
 * (crawlee/packages/core/src/session_pool/{session,session_pool}.ts) — the
 * mechanic row 71 (crawlee) names as unported. A session represents one
 * "user" identity (own usage/error score, optional custom headers), and the
 * pool rotates identities so a single banned identity never stalls a crawl.
 *
 * Core semantics, mirrored from the source:
 *
 *  • errorScore starts 0; `markBad()` (+1) on transient request errors and
 *    `markGood()` (−errorScoreDecrement, floor 0) on success. A session whose
 *    errorScore reaches `maxErrorScore` is *blocked*.
 *  • usageCount increments on every mark; reaching `maxUsageCount` retires.
 *  • `retire()` is terminal — a retired session is never picked again and
 *    cannot be revived by `markGood()`. Crawlee retires on blocked HTTP
 *    status codes (default 401/403/429) and on `SessionError`s.
 *  • `isUsable()` = not retired, not blocked, not expired
 *    (createdAt + maxAgeSecs), usageCount below maxUsageCount.
 *  • The pool creates fresh sessions while it has space; once full it reuses
 *    per the `sessionReuseStrategy` (random | round-robin | use-until-failure)
 *    and drops unusable sessions to make room.
 *
 * Divergences from Crawlee (in-process, no storage layer):
 *  • No KeyValueStore persistence or PERSIST_STATE events — `getState()` /
 *    `restore()` provide the persistence-shaped surface (pool + session
 *    snapshots) so a caller can persist/restore state itself.
 *  • Sessions carry no cookie jar of their own (the spider keeps its single
 *    global MemoryCookieJar); per-identity request headers are the supported
 *    anti-bot seam via `userData.headers`, matching Crawlee's documented use
 *    of `userData` for auth tokens / identity headers.
 *  • Fingerprints are emitted on request only (no auto-apply): the crawl
 *    loop merges them like Crawlee's browser crawlers do, via userData.
 */

export const BLOCKED_STATUS_CODES = [401, 403, 429] as const;

/** True for the status codes Crawlee treats as identity-blocking (401/403/429). */
export function isBlockedStatus(status: number): boolean {
  return (BLOCKED_STATUS_CODES as readonly number[]).includes(status);
}

export type SessionReuseStrategy = "random" | "round-robin" | "use-until-failure";

export interface SessionFingerprint {
  browser: string;
  platform: string;
  device: string;
}

// Realistic (browser, platform, device) combos people actually run; anything
// not listed (edge on android, safari on windows, desktop mobile) is left out
// so a randomized default never produces a fingerprint that is itself a give-away.
const PROFILES_BY_PLATFORM: SessionFingerprint[] = [
  { browser: "chrome", platform: "windows", device: "desktop" },
  { browser: "firefox", platform: "windows", device: "desktop" },
  { browser: "edge", platform: "windows", device: "desktop" },
  { browser: "chrome", platform: "macos", device: "desktop" },
  { browser: "firefox", platform: "macos", device: "desktop" },
  { browser: "safari", platform: "macos", device: "desktop" },
  { browser: "edge", platform: "macos", device: "desktop" },
  { browser: "chrome", platform: "linux", device: "desktop" },
  { browser: "firefox", platform: "linux", device: "desktop" },
  { browser: "chrome", platform: "android", device: "mobile" },
  { browser: "firefox", platform: "android", device: "mobile" },
  { browser: "safari", platform: "ios", device: "mobile" },
];

/** Host OS name in crawlee fingerprint vocabulary (win32→windows, darwin→macos, else linux). */
export function hostPlatform(): string {
  const p = typeof process !== "undefined" ? process.platform : "";
  if (p === "win32") return "windows";
  if (p === "darwin") return "macos";
  return "linux";
}

/**
 * Build a fingerprint whose `platform` matches the host OS and whose
 * browser/device are randomized within the realistic profiles for that
 * platform (mirrors crawlee's `createDefaultSessionFingerprint`).
 */
export function createDefaultSessionFingerprint(platform = hostPlatform()): SessionFingerprint {
  const profiles = PROFILES_BY_PLATFORM.filter((p) => p.platform === platform);
  // Never empty: either the platform matched a profile, or we fall back to the full list.
  const pool = profiles.length ? profiles : PROFILES_BY_PLATFORM;
  return { ...pool[Math.floor(Math.random() * pool.length)]! };
}

export interface CrawlSessionOptions {
  id?: string;
  /** Seconds after creation at which the session is considered expired. Default 3000. */
  maxAgeSecs?: number;
  /** Custom data, e.g. per-identity request headers under `headers`. */
  userData?: Record<string, unknown>;
  /** Error score at which the session is blocked. Default 3. */
  maxErrorScore?: number;
  /** markGood() heals the error score by this amount (floor 0). Default 0.5. */
  errorScoreDecrement?: number;
  createdAt?: Date;
  expiresAt?: Date;
  usageCount?: number;
  errorScore?: number;
  /** Uses before the session is retired. Default 50. */
  maxUsageCount?: number;
  /** Terminal state flag (used when restoring persisted sessions). */
  retired?: boolean;
  /** Browser/HTTP identity fingerprint tied to this session. */
  fingerprint?: SessionFingerprint;
}

export interface CrawlSessionState {
  id: string;
  userData: Record<string, unknown>;
  maxErrorScore: number;
  errorScoreDecrement: number;
  expiresAt: string;
  createdAt: string;
  usageCount: number;
  maxUsageCount: number;
  errorScore: number;
  retired: boolean;
  fingerprint?: SessionFingerprint;
}

let _sessionSeq = 0;
function defaultSessionId(): string {
  _sessionSeq += 1;
  return `session_${_sessionSeq}_${Date.now().toString(36)}`;
}

/**
 * One crawl identity. Blocked when `errorScore >= maxErrorScore`; retired is
 * terminal. Call `markGood()` after a successful request, `markBad()` after a
 * transient error, and `retire()` when the identity itself is the problem
 * (e.g. a 403 response).
 */
export class CrawlSession {
  readonly id: string;
  readonly userData: Record<string, unknown>;
  readonly maxErrorScore: number;
  readonly errorScoreDecrement: number;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly maxUsageCount: number;
  fingerprint?: SessionFingerprint;
  private _usageCount: number;
  private _errorScore: number;
  private _retired: boolean;

  constructor(options: CrawlSessionOptions = {}) {
    const {
      id = defaultSessionId(),
      maxAgeSecs = 3000,
      userData = {},
      maxErrorScore = 3,
      errorScoreDecrement = 0.5,
      createdAt = new Date(),
      usageCount = 0,
      errorScore = 0,
      maxUsageCount = 50,
      retired = false,
      fingerprint,
      // Anchored to createdAt (not "now") so the documented createdAt + maxAgeSecs holds.
      expiresAt = new Date(createdAt.getTime() + maxAgeSecs * 1000),
    } = options;
    this.id = id;
    this.userData = userData;
    this.maxErrorScore = maxErrorScore;
    this.errorScoreDecrement = errorScoreDecrement;
    this.createdAt = createdAt;
    this.expiresAt = expiresAt;
    this.maxUsageCount = maxUsageCount;
    this.fingerprint = fingerprint;
    this._usageCount = usageCount;
    this._errorScore = errorScore;
    this._retired = retired;
  }

  get errorScore(): number {
    return this._errorScore;
  }
  get usageCount(): number {
    return this._usageCount;
  }
  get retired(): boolean {
    return this._retired;
  }

  /** Blocked once the error score reaches `maxErrorScore`. */
  isBlocked(): boolean {
    return this._errorScore >= this.maxErrorScore;
  }

  /** Expired once `createdAt + maxAgeSecs` has passed. */
  isExpired(): boolean {
    return this.expiresAt.getTime() <= Date.now();
  }

  isMaxUsageCountReached(): boolean {
    return this._usageCount >= this.maxUsageCount;
  }

  /** Usable = not retired, not blocked, not expired, usage below the cap. */
  isUsable(): boolean {
    return !this._retired && !this.isBlocked() && !this.isExpired() && !this.isMaxUsageCountReached();
  }

  /** Call after a successful use: +1 usage, heal error score by the decrement. */
  markGood(): void {
    this._usageCount += 1;
    if (this._errorScore > 0) {
      this._errorScore = Math.max(0, this._errorScore - this.errorScoreDecrement);
    }
    this.maybeSelfRetire();
  }

  /** Call after an unsuccessful use (e.g. timeout): +1 usage, +1 error score. */
  markBad(): void {
    this._errorScore += 1;
    this._usageCount += 1;
    this.maybeSelfRetire();
  }

  /**
   * Permanently retires the session — `isUsable()` is false from here on and
   * no `markGood()`/`markBad()` revives it. Calling twice is a no-op.
   */
  retire(): void {
    if (this._retired) return;
    this._errorScore += this.maxErrorScore;
    this._usageCount += 1;
    this._retired = true;
  }

  /** Snapshot for persistence (crawlee `getState()`). */
  getState(): CrawlSessionState {
    return {
      id: this.id,
      userData: this.userData,
      maxErrorScore: this.maxErrorScore,
      errorScoreDecrement: this.errorScoreDecrement,
      expiresAt: this.expiresAt.toISOString(),
      createdAt: this.createdAt.toISOString(),
      usageCount: this._usageCount,
      maxUsageCount: this.maxUsageCount,
      errorScore: this._errorScore,
      retired: this._retired,
      fingerprint: this.fingerprint,
    };
  }

  private maybeSelfRetire(): void {
    if (!this.isUsable()) {
      this.retire();
    }
  }
}

export interface SessionPoolOptions {
  /** Max concurrent identities. Default 1000. */
  maxPoolSize?: number;
  /** Pool-wide session options merged into every new session. */
  sessionOptions?: CrawlSessionOptions;
  /** Custom session factory (may be async). */
  createSessionFunction?: (options?: { sessionOptions?: CrawlSessionOptions }) => Promise<CrawlSession>;
  sessionReuseStrategy?: SessionReuseStrategy;
}

export interface SessionPoolState {
  usableSessionsCount: number;
  retiredSessionsCount: number;
  sessions: CrawlSessionState[];
}

/**
 * Rotates crawl identities. Creates a fresh session while the pool has space;
 * once full, reuses usable sessions per `sessionReuseStrategy` and drops
 * unusable ones to make room (crawlee `SessionPool` semantics).
 */
export class SessionPool {
  private readonly _sessions: CrawlSession[] = [];
  private readonly _sessionMap = new Map<string, CrawlSession>();
  private readonly _maxPoolSize: number;
  private readonly _sessionOptions: CrawlSessionOptions;
  private readonly _createSessionFunction: NonNullable<SessionPoolOptions["createSessionFunction"]>;
  private readonly _sessionReuseStrategy: SessionReuseStrategy;
  private _roundRobinIndex = 0;
  /** Serializes session creation like crawlee's AsyncQueue guard. */
  private _lock: Promise<void> = Promise.resolve();

  constructor(options: SessionPoolOptions = {}) {
    const {
      maxPoolSize = 1000,
      sessionOptions = {},
      createSessionFunction,
      sessionReuseStrategy = "random",
    } = options;
    this._maxPoolSize = maxPoolSize;
    this._sessionOptions = sessionOptions;
    this._createSessionFunction = createSessionFunction ?? (async (o) => new CrawlSession(o?.sessionOptions));
    this._sessionReuseStrategy = sessionReuseStrategy;
  }

  get sessions(): readonly CrawlSession[] {
    return this._sessions;
  }

  usableSessionsCount(): number {
    return this._sessions.filter((s) => s.isUsable()).length;
  }

  retiredSessionsCount(): number {
    return this._sessions.filter((s) => !s.isUsable()).length;
  }

  /** Adds an existing session (or options to create one). Duplicate ids throw. */
  async addSession(options: CrawlSession | CrawlSessionOptions = {}): Promise<void> {
    const id = options instanceof CrawlSession ? options.id : options.id;
    if (id && this._sessionMap.has(id)) {
      throw new Error(`Cannot add session with id '${id}' as it already exists in the pool`);
    }
    if (!this.hasSpaceForSession()) {
      this.removeRetiredSessions();
    }
    const session =
      options instanceof CrawlSession ? options : await this.invokeCreateSessionFunction(options);
    this.registerSession(session);
  }

  /** Creates and registers a brand-new session, returning it. */
  async newSession(sessionOptions?: CrawlSessionOptions): Promise<CrawlSession> {
    const session = await this.invokeCreateSessionFunction(sessionOptions);
    this.registerSession(session);
    return session;
  }

  /**
   * Gets a usable session. With `sessionId`, returns that usable session or
   * `undefined`. Otherwise picks per the reuse strategy — creating a new
   * session while the pool has space, and dropping unusable sessions to make
   * room once full. Returns `undefined` only when no session is usable and
   * none can be created.
   */
  async getSession(sessionId?: string): Promise<CrawlSession | undefined> {
    const release = await this.acquire();
    try {
      if (sessionId) {
        const session = this._sessionMap.get(sessionId);
        return session?.isUsable() ? session : undefined;
      }

      const picked = this.pickSession();
      if (picked) return picked;

      if (this.hasSpaceForSession()) {
        return await this.createSession();
      }
      this.removeRetiredSessions();
      return await this.createSession();
    } finally {
      release();
    }
  }

  /** Persistence-shaped snapshot (no storage backend in-process). */
  getState(): SessionPoolState {
    return {
      usableSessionsCount: this.usableSessionsCount(),
      retiredSessionsCount: this.retiredSessionsCount(),
      sessions: this._sessions.map((s) => s.getState()),
    };
  }

  /** Restores sessions from a `getState()` snapshot; only usable ones register (crawlee semantics). */
  async restore(state: SessionPoolState): Promise<void> {
    for (const sessionState of state.sessions) {
      const restored = await this.invokeCreateSessionFunction({
        ...sessionState,
        createdAt: new Date(sessionState.createdAt),
        expiresAt: new Date(sessionState.expiresAt),
      });
      if (restored.isUsable()) {
        this.registerSession(restored);
      }
    }
  }

  private async acquire(): Promise<() => void> {
    let release!: () => void;
    const prev = this._lock;
    this._lock = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    return release;
  }

  private hasSpaceForSession(): boolean {
    return this._sessions.length < this._maxPoolSize;
  }

  private registerSession(session: CrawlSession): void {
    this._sessions.push(session);
    this._sessionMap.set(session.id, session);
  }

  private removeRetiredSessions(): void {
    for (let i = this._sessions.length - 1; i >= 0; i--) {
      const s = this._sessions[i];
      if (s && !s.isUsable()) {
        this._sessionMap.delete(s.id);
        this._sessions.splice(i, 1);
      }
    }
  }

  private async invokeCreateSessionFunction(perCallOptions?: CrawlSessionOptions): Promise<CrawlSession> {
    const sessionOptions: CrawlSessionOptions = {
      fingerprint: createDefaultSessionFingerprint(),
      ...this._sessionOptions,
      ...perCallOptions,
    };
    return this._createSessionFunction({ sessionOptions });
  }

  private async createSession(): Promise<CrawlSession> {
    const session = await this.invokeCreateSessionFunction();
    this.registerSession(session);
    return session;
  }

  private pickSession(): CrawlSession | undefined {
    if (this._sessionReuseStrategy !== "use-until-failure" && this.hasSpaceForSession()) {
      return undefined;
    }

    if (this._sessionReuseStrategy === "use-until-failure") {
      return this._sessions.find((s) => s.isUsable());
    }

    if (this._sessions.length === 0) return undefined;

    const picked: CrawlSession | undefined =
      this._sessionReuseStrategy === "round-robin"
        ? this._sessions[this._roundRobinIndex % this._sessions.length]
        : this._sessions[Math.floor(Math.random() * this._sessions.length)];
    if (this._sessionReuseStrategy === "round-robin") {
      this._roundRobinIndex += 1;
    }

    return picked && picked.isUsable() ? picked : undefined;
  }
}
