package db_test

import (
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	_ "modernc.org/sqlite"

	"open-board/pkg/db"
)

func openBoard(t *testing.T) *db.DB {
	t.Helper()
	d, err := db.OpenFile(filepath.Join(t.TempDir(), "board.sqlite"))
	if err != nil {
		t.Fatalf("open board: %v", err)
	}
	t.Cleanup(func() { d.Close() })
	return d
}

func TestEventLog(t *testing.T) {
	d := openBoard(t)

	first, err := d.AppendEvent("default", "sprint-1", "claude", "ask", "ask: T1 who owns the parser? @alice", []string{"@alice"}, "")
	if err != nil {
		t.Fatal(err)
	}
	if first.ID == 0 || first.CreatedAt.IsZero() {
		t.Fatalf("event has no id or timestamp: %+v", first)
	}

	if _, err := d.AppendEvent("default", "sprint-2", "cline", "note", "hello", nil, ""); err != nil {
		t.Fatal(err)
	}

	events, err := d.GetEventsAfter("sprint-1", 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || events[0].ActorID != "claude" {
		t.Fatalf("unexpected tail: %+v", events)
	}

	recent, err := d.RecentEvents("", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(recent) != 2 {
		t.Fatalf("want 2 recent events, got %d", len(recent))
	}
	if recent[0].ID > recent[1].ID {
		t.Fatal("recent events should be oldest first")
	}

	threads, err := d.ListThreads(10)
	if err != nil {
		t.Fatal(err)
	}
	if len(threads) != 2 || threads[0].Thread != "sprint-2" {
		t.Fatalf("threads should be newest first: %+v", threads)
	}

	found, err := d.SearchEvents("parser", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(found) != 1 || found[0].ID != first.ID {
		t.Fatalf("search missed the event: %+v", found)
	}

	stats, err := d.Stats()
	if err != nil {
		t.Fatal(err)
	}
	if stats.Events != 2 || stats.Threads != 2 {
		t.Fatalf("unexpected stats: %+v", stats)
	}
}

func TestClaimLeaseAndCompletion(t *testing.T) {
	d := openBoard(t)
	if _, err := d.UpsertTask("T1", "default", "sprint-1", "fix parser", "parse(string) error", "fs:write", ""); err != nil {
		t.Fatal(err)
	}

	task, err := d.ClaimTask("T1", "claude", 300)
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	if task.State != db.StateClaimed || task.Owner == nil || *task.Owner != "claude" || task.LeaseUntil == nil {
		t.Fatalf("unexpected claimed task: %+v", task)
	}

	if _, err := d.ClaimTask("T1", "cline", 300); !errors.Is(err, db.ErrTaskTaken) {
		t.Fatalf("second claim should be refused, got %v", err)
	}

	renewed, err := d.RenewTask("T1", "claude", 600)
	if err != nil {
		t.Fatalf("renew: %v", err)
	}
	if !renewed.LeaseUntil.After(time.Now().Add(9 * time.Minute)) {
		t.Fatalf("lease was not extended: %v", renewed.LeaseUntil)
	}

	working, err := d.SetTaskState("T1", "claude", db.StateWorking)
	if err != nil || working.State != db.StateWorking {
		t.Fatalf("working: %v %+v", err, working)
	}

	if _, err := d.RenewTask("T1", "cline", 300); !errors.Is(err, db.ErrTaskNotOwned) {
		t.Fatalf("renew by a stranger should fail, got %v", err)
	}

	if _, err := d.CompleteTask("T1", "cline", false); !errors.Is(err, db.ErrTaskNotOwned) {
		t.Fatalf("complete by a stranger should fail, got %v", err)
	}

	done, err := d.CompleteTask("T1", "claude", false)
	if err != nil || done.State != db.StateDone {
		t.Fatalf("complete: %v %+v", err, done)
	}
	if done.LeaseUntil != nil {
		t.Fatal("a finished task should hold no lease")
	}
}

func TestLeaseExpiryReturnsTaskToQueue(t *testing.T) {
	d := openBoard(t)
	if _, err := d.UpsertTask("T1", "default", "sprint-1", "slow work", "", "", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := d.ClaimTask("T1", "claude", 1); err != nil {
		t.Fatal(err)
	}

	time.Sleep(1200 * time.Millisecond)

	n, err := d.RevertExpiredTasks()
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("want 1 reclaimed task, got %d", n)
	}
	task, err := d.GetTask("T1")
	if err != nil {
		t.Fatal(err)
	}
	if task.State != db.StateQueued || task.Owner != nil {
		t.Fatalf("expired task should be queued and unowned: %+v", task)
	}

	if _, err := d.ClaimTask("T1", "cline", 300); err != nil {
		t.Fatalf("a released task should be claimable: %v", err)
	}
}

func TestTaskDependencies(t *testing.T) {
	d := openBoard(t)
	if _, err := d.UpsertTask("T1", "default", "sprint-1", "schema", "", "", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := d.UpsertTask("T2", "default", "sprint-1", "api", "", "", "T1"); err != nil {
		t.Fatal(err)
	}

	if _, err := d.ClaimTask("T2", "cline", 300); !errors.Is(err, db.ErrTaskBlocked) {
		t.Fatalf("blocked task should not be claimable, got %v", err)
	}
	if _, err := d.ClaimTask("T1", "claude", 300); err != nil {
		t.Fatal(err)
	}
	if _, err := d.CompleteTask("T1", "claude", false); err != nil {
		t.Fatal(err)
	}
	if _, err := d.ClaimTask("T2", "cline", 300); err != nil {
		t.Fatalf("task should be claimable after its dependency: %v", err)
	}
}

func TestFileLocks(t *testing.T) {
	d := openBoard(t)
	key := "c:\\repo\\src\\db.go"
	ok, holder, err := d.AcquireLock(key, "C:\\repo\\src\\db.go", "T1", "claude")
	if err != nil || !ok {
		t.Fatalf("acquire: %v ok=%t", err, ok)
	}
	if holder != nil {
		t.Fatal("a fresh lock has no holder")
	}

	ok, holder, err = d.AcquireLock(key, "C:\\repo\\src\\db.go", "T2", "cline")
	if err != nil {
		t.Fatal(err)
	}
	if ok || holder == nil || holder.OwnerAgent != "claude" {
		t.Fatalf("second acquire should report claude, got ok=%t holder=%+v", ok, holder)
	}

	if released, _ := d.ReleaseLock(key, "cline", false); released {
		t.Fatal("a stranger must not release the lock")
	}
	if released, _ := d.ReleaseLock(key, "claude", false); !released {
		t.Fatal("the owner should release the lock")
	}

	if ok, _, err := d.AcquireLock(key, "C:\\repo\\src\\db.go", "T1", "claude"); err != nil || !ok {
		t.Fatalf("re-acquire after release: ok=%t err=%v", ok, err)
	}
	n, err := d.ReleaseLocksForTask("T1")
	if err != nil || n != 1 {
		t.Fatalf("finishing a task should release its locks: n=%d err=%v", n, err)
	}
}

func TestMentionsAndCursor(t *testing.T) {
	d := openBoard(t)
	if _, err := d.AppendEvent("default", "sprint-1", "claude", "ask", "ask: T1 @alice can you review?", []string{"@alice"}, ""); err != nil {
		t.Fatal(err)
	}

	events, err := d.Mentioned("alice", "sprint-1", 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 {
		t.Fatalf("want 1 mention, got %d", len(events))
	}

	if err := d.SetCursor("alice", "sprint-1", events[0].ID); err != nil {
		t.Fatal(err)
	}
	events, err = d.Mentioned("alice", "sprint-1", events[0].ID, 10)
	if err != nil || len(events) != 0 {
		t.Fatalf("cursor should hide read mentions: %v %d", err, len(events))
	}

	unread, err := d.UnreadMentions("alice", "sprint-1")
	if err != nil || unread != 0 {
		t.Fatalf("unread after cursor: %d %v", unread, err)
	}

	if _, err := d.AppendEvent("default", "sprint-1", "cline", "note", "@alice one more thing", []string{"@alice"}, ""); err != nil {
		t.Fatal(err)
	}
	unread, err = d.UnreadMentions("alice", "sprint-1")
	if err != nil || unread != 1 {
		t.Fatalf("want 1 unread mention, got %d %v", unread, err)
	}

	all, err := d.Mentioned("bob", "sprint-1", 0, 10)
	if err != nil || len(all) != 0 {
		t.Fatalf("bob was not mentioned: %d %v", len(all), err)
	}
}

func TestLegacySchemaMigratesWithoutLosingRows(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.sqlite")
	raw, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = raw.Exec(`
		CREATE TABLE events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			channel TEXT NOT NULL, thread TEXT NOT NULL, actor_id TEXT NOT NULL,
			event_type TEXT NOT NULL, content TEXT NOT NULL, slice_ref TEXT,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		);
		CREATE TABLE tasks (
			id TEXT PRIMARY KEY, channel TEXT NOT NULL, thread TEXT NOT NULL, title TEXT NOT NULL,
			contract_interface TEXT NOT NULL, required_caps TEXT NOT NULL,
			state TEXT NOT NULL DEFAULT 'queued', owner TEXT, lease_until TIMESTAMP,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		);
		CREATE TABLE file_locks (
			file_path TEXT PRIMARY KEY, owner_task TEXT NOT NULL, owner_agent TEXT NOT NULL,
			acquired_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		);
		CREATE TABLE agents (
			name TEXT PRIMARY KEY, capabilities TEXT NOT NULL, pid INTEGER,
			state TEXT DEFAULT 'asleep', last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		);
		INSERT INTO events (channel, thread, actor_id, event_type, content, created_at)
			VALUES ('default', 'sprint-1', 'claude', 'done', 'done: T1 shipped', '2026-11-21 10:00:00');
		INSERT INTO tasks (id, channel, thread, title, contract_interface, required_caps, state, owner, lease_until)
			VALUES ('T1', 'default', 'sprint-1', 'old task', 'iface', 'fs:write', 'claimed', 'claude', '2026-11-21 11:00:00');
		INSERT INTO agents (name, capabilities, pid, state) VALUES ('claude', 'fs:write', 42, 'working');
		INSERT INTO file_locks (file_path, owner_task, owner_agent) VALUES ('C:\repo\a.go', 'T1', 'claude');
	`)
	if err != nil {
		t.Fatalf("build legacy db: %v", err)
	}
	raw.Close()

	d, err := db.OpenFile(path)
	if err != nil {
		t.Fatalf("migrate legacy db: %v", err)
	}
	defer d.Close()

	events, err := d.GetEventsAfter("sprint-1", 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 {
		t.Fatalf("events were lost: %+v", events)
	}
	if events[0].CreatedAt.Year() != 2026 || events[0].Content != "done: T1 shipped" {
		t.Fatalf("event was not converted: %+v", events[0])
	}

	task, err := d.GetTask("T1")
	if err != nil {
		t.Fatal(err)
	}
	if task.Owner == nil || *task.Owner != "claude" || task.LeaseUntil == nil {
		t.Fatalf("task was not converted: %+v", task)
	}
	if task.CreatedAt.IsZero() || task.UpdatedAt.IsZero() {
		t.Fatal("task timestamps missing after migration")
	}

	locks, err := d.ListLocks()
	if err != nil || len(locks) != 1 {
		t.Fatalf("lock was lost: %+v %v", locks, err)
	}
	if locks[0].Key == "" || locks[0].OwnerAgent != "claude" {
		t.Fatalf("lock was not rebuilt: %+v", locks[0])
	}

	agents, err := d.ListAgents()
	if err != nil || len(agents) != 1 || agents[0].LastSeen.IsZero() {
		t.Fatalf("agent was lost: %+v %v", agents, err)
	}

	if _, err := d.AppendEvent("default", "sprint-1", "cline", "note", "after migration", nil, ""); err != nil {
		t.Fatalf("migrated board should accept writes: %v", err)
	}
}

func TestSnapshotTo(t *testing.T) {
	dir := t.TempDir()
	d, err := db.Open(dir, "default")
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	if _, err := d.AppendEvent("default", "sprint-1", "human", "note", "snapshot me", nil, ""); err != nil {
		t.Fatal(err)
	}

	path := filepath.Join(dir, "snapshot.sqlite")
	if err := d.SnapshotTo(path); err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Size() == 0 {
		t.Fatalf("snapshot is empty: %v", err)
	}

	restored, err := db.OpenFile(path)
	if err != nil {
		t.Fatalf("open snapshot: %v", err)
	}
	defer restored.Close()
	events, err := restored.RecentEvents("", 5)
	if err != nil || len(events) != 1 {
		t.Fatalf("snapshot should hold the event: %+v %v", events, err)
	}
}
