// Package db is the board's persistence engine: one SQLite database per
// channel, in WAL mode, with an append-only event log and the task, lock,
// cursor and agent tables the broker keeps beside it.
package db

import (
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

// Task states.
const (
	StateQueued  = "queued"
	StateClaimed = "claimed"
	StateWorking = "working"
	StateDone    = "done"
	StateFailed  = "failed"
)

// Errors a caller can branch on.
var (
	ErrTaskNotFound = errors.New("task not found")
	ErrTaskTaken    = errors.New("task is held by another agent")
	ErrTaskBlocked  = errors.New("task is waiting on a dependency")
	ErrTaskNotOwned = errors.New("task is not yours")
	ErrTaskExists   = errors.New("task already exists")
)

// Event is one immutable entry in a channel's log.
type Event struct {
	ID        int64     `json:"id"`
	Channel   string    `json:"channel"`
	Thread    string    `json:"thread"`
	ActorID   string    `json:"actor_id"`
	EventType string    `json:"event_type"`
	Content   string    `json:"content"`
	Mentions  []string  `json:"mentions,omitempty"`
	SliceRef  string    `json:"slice_ref,omitempty"`
	CreatedAt time.Time `json:"created_at"`
}

// Task is a unit of work with an explicit contract, held under a lease.
type Task struct {
	ID                string     `json:"id"`
	Channel           string     `json:"channel"`
	Thread            string     `json:"thread"`
	Title             string     `json:"title"`
	ContractInterface string     `json:"contract_interface"`
	RequiredCaps      string     `json:"required_caps"`
	DependsOn         string     `json:"depends_on,omitempty"`
	State             string     `json:"state"`
	Owner             *string    `json:"owner,omitempty"`
	LeaseUntil        *time.Time `json:"lease_until,omitempty"`
	CreatedAt         time.Time  `json:"created_at"`
	UpdatedAt         time.Time  `json:"updated_at"`
}

// FileLock is an exclusive claim on one path.
type FileLock struct {
	FilePath   string    `json:"file_path"`
	Key        string    `json:"key"`
	OwnerTask  string    `json:"owner_task"`
	OwnerAgent string    `json:"owner_agent"`
	AcquiredAt time.Time `json:"acquired_at"`
}

// Agent is a registered participant.
type Agent struct {
	Name         string    `json:"name"`
	Capabilities string    `json:"capabilities"`
	PID          int       `json:"pid"`
	State        string    `json:"state"`
	LastSeen     time.Time `json:"last_seen"`
}

// ThreadSummary is one row of the channel's thread list.
type ThreadSummary struct {
	Thread    string    `json:"thread"`
	LastID    int64     `json:"last_id"`
	Events    int64     `json:"events"`
	UpdatedAt time.Time `json:"updated_at"`
}

// Stats is the inspector's headline numbers.
type Stats struct {
	Events  int64          `json:"events"`
	Threads int64          `json:"threads"`
	Locks   int64          `json:"locks"`
	Agents  int64          `json:"agents"`
	Tasks   map[string]int `json:"tasks"`
}

// DB is one channel's database.
type DB struct {
	conn *sql.DB
	path string
}

// Open opens (and migrates) the database for a channel under dir.
func Open(dir, channel string) (*DB, error) {
	channelDir := filepath.Join(dir, channel)
	if err := os.MkdirAll(channelDir, 0o755); err != nil {
		return nil, fmt.Errorf("create channel directory: %w", err)
	}
	return OpenFile(filepath.Join(channelDir, "board.sqlite"))
}

// OpenFile opens (and migrates) the database at path.
func OpenFile(path string) (*DB, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return nil, fmt.Errorf("create database directory: %w", err)
	}

	dsn := abs + "?_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)"
	conn, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite database: %w", err)
	}
	// One writer at a time keeps SQLite's busy handling predictable.
	conn.SetMaxOpenConns(8)

	d := &DB{conn: conn, path: abs}
	if err := d.migrate(); err != nil {
		conn.Close()
		return nil, fmt.Errorf("migrate database: %w", err)
	}
	return d, nil
}

// Path returns the database file's absolute path.
func (d *DB) Path() string { return d.path }

// Close closes the database.
func (d *DB) Close() error { return d.conn.Close() }

func nowMS() int64 { return time.Now().UnixMilli() }

func msToTime(ms int64) time.Time {
	if ms == 0 {
		return time.Time{}
	}
	return time.UnixMilli(ms).UTC()
}

func (d *DB) migrate() error {
	var version int
	if err := d.conn.QueryRow(`PRAGMA user_version`).Scan(&version); err != nil {
		return err
	}

	legacy := false
	if typ, ok := d.columnType("events", "created_at"); ok && !strings.EqualFold(typ, "INTEGER") {
		legacy = true
	}

	if legacy {
		if err := d.migrateLegacy(); err != nil {
			return err
		}
		_, err := d.conn.Exec(`PRAGMA user_version = 2`)
		return err
	}

	// A database already at the current version needs no DDL: reopening a
	// board must not replay every CREATE TABLE on each broker start.
	if version >= 2 && d.tableExists("events") {
		return nil
	}

	// One transaction for the whole schema keeps first-start commit overhead to
	// a single WAL flush instead of one per statement.
	tx, err := d.conn.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(schemaV2 + indexV2); err != nil {
		return err
	}
	if _, err := tx.Exec(`PRAGMA user_version = 2`); err != nil {
		return err
	}
	return tx.Commit()
}

func (d *DB) tableExists(table string) bool {
	var name string
	err := d.conn.QueryRow(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, table).Scan(&name)
	return err == nil
}

func (d *DB) columnType(table, column string) (string, bool) {
	rows, err := d.conn.Query(`PRAGMA table_info(` + quoteIdent(table) + `)`)
	if err != nil {
		return "", false
	}
	defer rows.Close()
	for rows.Next() {
		var (
			cid       int
			name, typ string
			notNull   int
			dflt      sql.NullString
			pk        int
		)
		if err := rows.Scan(&cid, &name, &typ, &notNull, &dflt, &pk); err != nil {
			return "", false
		}
		if name == column {
			return typ, true
		}
	}
	return "", false
}

// migrateLegacy rebuilds a v1 schema (TEXT timestamps, no mentions or
// dependencies) as v2, copying every row across.
func (d *DB) migrateLegacy() error {
	var legacy []string
	for _, t := range []string{"events", "tasks", "file_locks", "agents"} {
		if d.tableExists(t) {
			legacy = append(legacy, t)
		}
	}

	tx, err := d.conn.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	for _, t := range legacy {
		if _, err := tx.Exec(`ALTER TABLE ` + t + ` RENAME TO ` + t + `_legacy`); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(schemaV2); err != nil {
		return err
	}

	now := nowMS()
	for _, copyStmt := range []string{
		`INSERT INTO events (id, channel, thread, actor_id, event_type, content, mentions, slice_ref, created_at)
		 SELECT id, channel, thread, actor_id, event_type, content, '', COALESCE(slice_ref, ''),
		   COALESCE(CAST(strftime('%s', created_at) AS INTEGER) * 1000, ` + fmt.Sprint(now) + `)
		 FROM events_legacy`,
		`INSERT INTO tasks (id, channel, thread, title, contract_interface, required_caps, depends_on, state, owner, lease_until, created_at, updated_at)
		 SELECT id, channel, thread, title, COALESCE(contract_interface, ''), COALESCE(required_caps, ''), '',
		   COALESCE(state, 'queued'), owner,
		   CASE WHEN lease_until IS NULL OR lease_until = '' THEN NULL
		        ELSE CAST(strftime('%s', lease_until) AS INTEGER) * 1000 END,
		   COALESCE(CAST(strftime('%s', created_at) AS INTEGER) * 1000, ` + fmt.Sprint(now) + `),
		   COALESCE(CAST(strftime('%s', created_at) AS INTEGER) * 1000, ` + fmt.Sprint(now) + `)
		 FROM tasks_legacy`,
		`INSERT INTO agents (name, capabilities, pid, state, last_seen)
		 SELECT name, COALESCE(capabilities, ''), COALESCE(pid, 0), COALESCE(state, 'idle'),
		   COALESCE(CAST(strftime('%s', last_seen) AS INTEGER) * 1000, ` + fmt.Sprint(now) + `)
		 FROM agents_legacy`,
		`INSERT INTO file_locks (lock_key, file_path, owner_task, owner_agent, acquired_at)
		 SELECT lower(file_path), file_path, COALESCE(owner_task, ''), owner_agent,
		   COALESCE(CAST(strftime('%s', acquired_at) AS INTEGER) * 1000, ` + fmt.Sprint(now) + `)
		 FROM file_locks_legacy`,
	} {
		if !contains(legacy, tableOfCopy(copyStmt)) {
			continue
		}
		if _, err := tx.Exec(copyStmt); err != nil {
			return err
		}
	}

	for _, t := range legacy {
		if _, err := tx.Exec(`DROP TABLE ` + t + `_legacy`); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(indexV2); err != nil {
		return err
	}
	return tx.Commit()
}

func contains(list []string, want string) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}

// tableOfCopy names the table a legacy copy statement reads from.
func tableOfCopy(stmt string) string {
	switch {
	case strings.Contains(stmt, "events_legacy"):
		return "events"
	case strings.Contains(stmt, "tasks_legacy"):
		return "tasks"
	case strings.Contains(stmt, "agents_legacy"):
		return "agents"
	case strings.Contains(stmt, "file_locks_legacy"):
		return "file_locks"
	}
	return ""
}

// SnapshotTo writes a consistent copy of the database to path.
func (d *DB) SnapshotTo(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	_ = os.Remove(path)
	stmt := `VACUUM INTO '` + strings.ReplaceAll(path, "'", "''") + `'`
	_, err := d.conn.Exec(stmt)
	return err
}

// AppendEvent appends one event and returns it.
func (d *DB) AppendEvent(channel, thread, actorID, eventType, content string, mentions []string, sliceRef string) (*Event, error) {
	created := nowMS()
	res, err := d.conn.Exec(`
		INSERT INTO events (channel, thread, actor_id, event_type, content, mentions, slice_ref, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`, channel, thread, actorID, eventType, content, encodeMentions(mentions), sliceRef, created)
	if err != nil {
		return nil, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return nil, err
	}
	return &Event{
		ID:        id,
		Channel:   channel,
		Thread:    thread,
		ActorID:   actorID,
		EventType: eventType,
		Content:   content,
		Mentions:  mentions,
		SliceRef:  sliceRef,
		CreatedAt: msToTime(created),
	}, nil
}

func encodeMentions(mentions []string) string {
	if len(mentions) == 0 {
		return ""
	}
	return "," + strings.Join(mentions, ",") + ","
}

func decodeMentions(raw string) []string {
	if raw == "" {
		return nil
	}
	parts := strings.Split(strings.Trim(raw, ","), ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

const eventColumns = `id, channel, thread, actor_id, event_type, content, COALESCE(mentions, ''), COALESCE(slice_ref, ''), created_at`

func scanEvent(row interface{ Scan(...any) error }) (Event, error) {
	var (
		e         Event
		mentions  string
		createdAt int64
	)
	err := row.Scan(&e.ID, &e.Channel, &e.Thread, &e.ActorID, &e.EventType, &e.Content, &mentions, &e.SliceRef, &createdAt)
	if err != nil {
		return Event{}, err
	}
	e.Mentions = decodeMentions(mentions)
	e.CreatedAt = msToTime(createdAt)
	return e, nil
}

// GetEventsAfter returns up to limit events in a thread newer than afterID.
func (d *DB) GetEventsAfter(thread string, afterID int64, limit int) ([]Event, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := d.conn.Query(`SELECT `+eventColumns+` FROM events WHERE thread = ? AND id > ? ORDER BY id ASC LIMIT ?`, thread, afterID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var events []Event
	for rows.Next() {
		e, err := scanEvent(rows)
		if err != nil {
			return nil, err
		}
		events = append(events, e)
	}
	return events, rows.Err()
}

// RecentEvents returns the newest events across every thread, oldest first.
func (d *DB) RecentEvents(thread string, limit int) ([]Event, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	var (
		rows *sql.Rows
		err  error
	)
	if thread == "" {
		rows, err = d.conn.Query(`SELECT `+eventColumns+` FROM events ORDER BY id DESC LIMIT ?`, limit)
	} else {
		rows, err = d.conn.Query(`SELECT `+eventColumns+` FROM events WHERE thread = ? ORDER BY id DESC LIMIT ?`, thread, limit)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var events []Event
	for rows.Next() {
		e, err := scanEvent(rows)
		if err != nil {
			return nil, err
		}
		events = append(events, e)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i, j := 0, len(events)-1; i < j; i, j = i+1, j-1 {
		events[i], events[j] = events[j], events[i]
	}
	return events, nil
}

// SearchEvents finds events whose content or author contains q.
func (d *DB) SearchEvents(q string, limit int) ([]Event, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	like := "%" + q + "%"
	rows, err := d.conn.Query(`SELECT `+eventColumns+` FROM events WHERE content LIKE ? OR actor_id LIKE ? OR thread LIKE ? ORDER BY id DESC LIMIT ?`, like, like, like, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var events []Event
	for rows.Next() {
		e, err := scanEvent(rows)
		if err != nil {
			return nil, err
		}
		events = append(events, e)
	}
	for i, j := 0, len(events)-1; i < j; i, j = i+1, j-1 {
		events[i], events[j] = events[j], events[i]
	}
	return events, rows.Err()
}

// Mentioned returns events that mention agent (or @all) after afterID.
func (d *DB) Mentioned(agent, thread string, afterID int64, limit int) ([]Event, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	pattern := "%,@" + strings.ToLower(strings.TrimPrefix(agent, "@")) + ",%"
	all := "%,@all,%"
	rows, err := d.conn.Query(`
		SELECT `+eventColumns+` FROM events
		WHERE thread = ? AND id > ? AND (mentions LIKE ? OR mentions LIKE ?)
		ORDER BY id ASC LIMIT ?
	`, thread, afterID, pattern, all, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var events []Event
	for rows.Next() {
		e, err := scanEvent(rows)
		if err != nil {
			return nil, err
		}
		events = append(events, e)
	}
	return events, rows.Err()
}

// ListThreads lists threads ordered by their newest event.
func (d *DB) ListThreads(limit int) ([]ThreadSummary, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := d.conn.Query(`
		SELECT thread, MAX(id), COUNT(*), MAX(created_at)
		FROM events GROUP BY thread ORDER BY MAX(id) DESC LIMIT ?
	`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []ThreadSummary
	for rows.Next() {
		var (
			t         ThreadSummary
			updatedAt int64
		)
		if err := rows.Scan(&t.Thread, &t.LastID, &t.Events, &updatedAt); err != nil {
			return nil, err
		}
		t.UpdatedAt = msToTime(updatedAt)
		out = append(out, t)
	}
	return out, rows.Err()
}

// Stats returns the board's headline numbers.
func (d *DB) Stats() (Stats, error) {
	s := Stats{Tasks: map[string]int{}}
	for _, q := range []struct {
		table string
		dest  *int64
	}{
		{"events", &s.Events},
		{"file_locks", &s.Locks},
		{"agents", &s.Agents},
	} {
		if err := d.conn.QueryRow(`SELECT COUNT(*) FROM ` + q.table).Scan(q.dest); err != nil {
			return s, err
		}
	}
	if err := d.conn.QueryRow(`SELECT COUNT(DISTINCT thread) FROM events`).Scan(&s.Threads); err != nil {
		return s, err
	}
	rows, err := d.conn.Query(`SELECT state, COUNT(*) FROM tasks GROUP BY state`)
	if err != nil {
		return s, err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			state string
			n     int
		)
		if err := rows.Scan(&state, &n); err != nil {
			return s, err
		}
		s.Tasks[state] = n
	}
	return s, rows.Err()
}

// CreateTask inserts a new task, and refuses an id that already exists.
func (d *DB) CreateTask(id, channel, thread, title, contract, caps, dependsOn string) (*Task, error) {
	now := nowMS()
	res, err := d.conn.Exec(`
		INSERT OR IGNORE INTO tasks (id, channel, thread, title, contract_interface, required_caps, depends_on, state, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
	`, id, channel, thread, title, contract, caps, dependsOn, now, now)
	if err != nil {
		return nil, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, fmt.Errorf("%w: %s", ErrTaskExists, id)
	}
	return d.GetTask(id)
}

// UpsertTask creates or updates a task's definition.
func (d *DB) UpsertTask(id, channel, thread, title, contract, caps, dependsOn string) (*Task, error) {
	now := nowMS()
	_, err := d.conn.Exec(`
		INSERT INTO tasks (id, channel, thread, title, contract_interface, required_caps, depends_on, state, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			title = excluded.title,
			thread = excluded.thread,
			contract_interface = excluded.contract_interface,
			required_caps = excluded.required_caps,
			depends_on = excluded.depends_on,
			updated_at = excluded.updated_at
	`, id, channel, thread, title, contract, caps, dependsOn, now, now)
	if err != nil {
		return nil, err
	}
	return d.GetTask(id)
}

const taskColumns = `id, channel, thread, title, contract_interface, required_caps, depends_on, state, owner, lease_until, created_at, updated_at`

func scanTask(row interface{ Scan(...any) error }) (Task, error) {
	var (
		t          Task
		owner      sql.NullString
		leaseUntil sql.NullInt64
		createdAt  int64
		updatedAt  int64
	)
	err := row.Scan(&t.ID, &t.Channel, &t.Thread, &t.Title, &t.ContractInterface, &t.RequiredCaps, &t.DependsOn,
		&t.State, &owner, &leaseUntil, &createdAt, &updatedAt)
	if err != nil {
		return Task{}, err
	}
	if owner.Valid {
		t.Owner = &owner.String
	}
	if leaseUntil.Valid && leaseUntil.Int64 > 0 {
		ts := msToTime(leaseUntil.Int64)
		t.LeaseUntil = &ts
	}
	t.CreatedAt = msToTime(createdAt)
	t.UpdatedAt = msToTime(updatedAt)
	return t, nil
}

// GetTask returns one task.
func (d *DB) GetTask(id string) (*Task, error) {
	row := d.conn.QueryRow(`SELECT `+taskColumns+` FROM tasks WHERE id = ?`, id)
	t, err := scanTask(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrTaskNotFound
	}
	if err != nil {
		return nil, err
	}
	return &t, nil
}

// ListTasks lists tasks, newest first, optionally filtered by thread and state.
func (d *DB) ListTasks(thread, state string) ([]Task, error) {
	q := `SELECT ` + taskColumns + ` FROM tasks`
	var (
		where []string
		args  []any
	)
	if thread != "" {
		where = append(where, "thread = ?")
		args = append(args, thread)
	}
	if state != "" {
		where = append(where, "state = ?")
		args = append(args, state)
	}
	if len(where) > 0 {
		q += " WHERE " + strings.Join(where, " AND ")
	}
	q += " ORDER BY created_at DESC, id DESC"

	rows, err := d.conn.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Task
	for rows.Next() {
		t, err := scanTask(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// ClaimTask atomically claims (or renews) a task for agent. It refuses a task
// another agent holds under a live lease, and a task whose dependency is not
// done yet.
func (d *DB) ClaimTask(taskID, agent string, leaseSeconds int) (*Task, error) {
	if leaseSeconds <= 0 {
		leaseSeconds = 300
	}
	tx, err := d.conn.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	var (
		state, dependsOn string
		owner            sql.NullString
		leaseUntil       sql.NullInt64
	)
	err = tx.QueryRow(`SELECT state, COALESCE(owner, ''), COALESCE(lease_until, 0), depends_on FROM tasks WHERE id = ?`, taskID).
		Scan(&state, &owner, &leaseUntil, &dependsOn)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrTaskNotFound
	}
	if err != nil {
		return nil, err
	}

	now := nowMS()
	live := leaseUntil.Int64 > now && (state == StateClaimed || state == StateWorking)
	if live && (!owner.Valid || owner.String != agent) {
		return nil, ErrTaskTaken
	}
	if state == StateDone {
		return nil, fmt.Errorf("%w: it is already done", ErrTaskTaken)
	}

	if dependsOn != "" {
		var depState string
		err := tx.QueryRow(`SELECT state FROM tasks WHERE id = ?`, dependsOn).Scan(&depState)
		if errors.Is(err, sql.ErrNoRows) || (err == nil && depState != StateDone) {
			return nil, ErrTaskBlocked
		}
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
	}

	expires := now + int64(leaseSeconds)*1000
	if _, err := tx.Exec(`
		UPDATE tasks SET state = ?, owner = ?, lease_until = ?, updated_at = ? WHERE id = ?
	`, StateClaimed, agent, expires, now, taskID); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return d.GetTask(taskID)
}

// RenewTask extends the lease of a task its owner holds.
func (d *DB) RenewTask(taskID, agent string, leaseSeconds int) (*Task, error) {
	if leaseSeconds <= 0 {
		leaseSeconds = 300
	}
	now := nowMS()
	res, err := d.conn.Exec(`
		UPDATE tasks SET lease_until = ?, updated_at = ?
		WHERE id = ? AND owner = ? AND state IN (?, ?)
	`, now+int64(leaseSeconds)*1000, now, taskID, agent, StateClaimed, StateWorking)
	if err != nil {
		return nil, err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return nil, ErrTaskNotOwned
	}
	return d.GetTask(taskID)
}

// SetTaskState moves a task its owner holds to working or failed.
func (d *DB) SetTaskState(taskID, agent, state string) (*Task, error) {
	switch state {
	case StateWorking, StateFailed:
	default:
		return nil, fmt.Errorf("cannot set task state %q", state)
	}
	now := nowMS()
	res, err := d.conn.Exec(`
		UPDATE tasks SET state = ?, updated_at = ? WHERE id = ? AND owner = ? AND state IN (?, ?)
	`, state, now, taskID, agent, StateClaimed, StateWorking)
	if err != nil {
		return nil, err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return nil, ErrTaskNotOwned
	}
	if state == StateFailed {
		if _, err := d.conn.Exec(`UPDATE tasks SET lease_until = NULL WHERE id = ?`, taskID); err != nil {
			return nil, err
		}
	}
	return d.GetTask(taskID)
}

// CompleteTask marks a task done, for its owner or for the supervisor with force.
func (d *DB) CompleteTask(taskID, agent string, force bool) (*Task, error) {
	now := nowMS()
	var (
		res sql.Result
		err error
	)
	if force {
		res, err = d.conn.Exec(`UPDATE tasks SET state = ?, lease_until = NULL, updated_at = ? WHERE id = ?`, StateDone, now, taskID)
	} else {
		res, err = d.conn.Exec(`UPDATE tasks SET state = ?, lease_until = NULL, updated_at = ? WHERE id = ? AND owner = ? AND state IN (?, ?)`,
			StateDone, now, taskID, agent, StateClaimed, StateWorking)
	}
	if err != nil {
		return nil, err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		if _, err := d.GetTask(taskID); err != nil {
			return nil, err
		}
		return nil, ErrTaskNotOwned
	}
	return d.GetTask(taskID)
}

// RevertExpiredTasks returns every task whose lease ran out to the queue.
func (d *DB) RevertExpiredTasks() (int64, error) {
	now := nowMS()
	res, err := d.conn.Exec(`
		UPDATE tasks SET state = ?, owner = NULL, lease_until = NULL, updated_at = ?
		WHERE state IN (?, ?) AND lease_until IS NOT NULL AND lease_until < ?
	`, StateQueued, now, StateClaimed, StateWorking, now)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// RequeueAgentTasks returns every claimed or working task owned by agent to
// the queue, so work an agent abandoned after a non-zero exit can be retried.
func (d *DB) RequeueAgentTasks(agent string) ([]Task, error) {
	if agent == "" {
		return nil, nil
	}
	tx, err := d.conn.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	rows, err := tx.Query(`SELECT `+taskColumns+` FROM tasks WHERE owner = ? AND state IN (?, ?)`, agent, StateClaimed, StateWorking)
	if err != nil {
		return nil, err
	}
	var out []Task
	for rows.Next() {
		t, err := scanTask(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, t)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return nil, tx.Commit()
	}

	now := nowMS()
	if _, err := tx.Exec(`
		UPDATE tasks SET state = ?, owner = NULL, lease_until = NULL, updated_at = ?
		WHERE owner = ? AND state IN (?, ?)
	`, StateQueued, now, agent, StateClaimed, StateWorking); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	for i := range out {
		out[i].State = StateQueued
		out[i].Owner = nil
		out[i].LeaseUntil = nil
		out[i].UpdatedAt = msToTime(now)
	}
	return out, nil
}

// ForceRequeueTask returns any task to the queue regardless of its owner or
// state, so a human supervisor can take work back from a stuck agent.
func (d *DB) ForceRequeueTask(taskID string) (*Task, error) {
	if taskID == "" {
		return nil, ErrTaskNotFound
	}
	res, err := d.conn.Exec(`
		UPDATE tasks SET state = ?, owner = NULL, lease_until = NULL, updated_at = ?
		WHERE id = ?
	`, StateQueued, nowMS(), taskID)
	if err != nil {
		return nil, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, ErrTaskNotFound
	}
	return d.GetTask(taskID)
}

// AcquireLock takes an exclusive lock on key. It returns false and the
// current holder when someone else holds it.
func (d *DB) AcquireLock(key, displayPath, taskID, agent string) (bool, *FileLock, error) {
	now := nowMS()
	res, err := d.conn.Exec(`
		INSERT OR IGNORE INTO file_locks (lock_key, file_path, owner_task, owner_agent, acquired_at)
		VALUES (?, ?, ?, ?, ?)
	`, key, displayPath, taskID, agent, now)
	if err != nil {
		return false, nil, err
	}
	n, _ := res.RowsAffected()
	if n > 0 {
		return true, nil, nil
	}
	row := d.conn.QueryRow(`SELECT file_path, lock_key, owner_task, owner_agent, acquired_at FROM file_locks WHERE lock_key = ?`, key)
	var (
		l          FileLock
		acquiredAt int64
	)
	if err := row.Scan(&l.FilePath, &l.Key, &l.OwnerTask, &l.OwnerAgent, &acquiredAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return false, nil, nil
		}
		return false, nil, err
	}
	l.AcquiredAt = msToTime(acquiredAt)
	return false, &l, nil
}

// ReleaseLock releases a lock its owner holds, or any lock when force is set.
func (d *DB) ReleaseLock(key, agent string, force bool) (bool, error) {
	var (
		res sql.Result
		err error
	)
	if force {
		res, err = d.conn.Exec(`DELETE FROM file_locks WHERE lock_key = ?`, key)
	} else {
		res, err = d.conn.Exec(`DELETE FROM file_locks WHERE lock_key = ? AND owner_agent = ?`, key, agent)
	}
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// ReleaseLocksForTask frees every lock a finished task still holds.
func (d *DB) ReleaseLocksForTask(taskID string) (int64, error) {
	if taskID == "" {
		return 0, nil
	}
	res, err := d.conn.Exec(`DELETE FROM file_locks WHERE owner_task = ?`, taskID)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// ListLocks lists every held lock, oldest first.
func (d *DB) ListLocks() ([]FileLock, error) {
	rows, err := d.conn.Query(`SELECT file_path, lock_key, owner_task, owner_agent, acquired_at FROM file_locks ORDER BY acquired_at ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []FileLock
	for rows.Next() {
		var (
			l          FileLock
			acquiredAt int64
		)
		if err := rows.Scan(&l.FilePath, &l.Key, &l.OwnerTask, &l.OwnerAgent, &acquiredAt); err != nil {
			return nil, err
		}
		l.AcquiredAt = msToTime(acquiredAt)
		out = append(out, l)
	}
	return out, rows.Err()
}

// UpsertAgent registers an agent or refreshes its registration.
func (d *DB) UpsertAgent(name, caps string, pid int, state string) error {
	_, err := d.conn.Exec(`
		INSERT INTO agents (name, capabilities, pid, state, last_seen)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(name) DO UPDATE SET
			capabilities = excluded.capabilities,
			pid = excluded.pid,
			state = excluded.state,
			last_seen = excluded.last_seen
	`, name, caps, pid, state, nowMS())
	return err
}

// TouchAgent records an agent's activity without clobbering its capabilities.
// An empty state leaves the agent's current state alone.
func (d *DB) TouchAgent(name, state string) error {
	_, err := d.conn.Exec(`
		INSERT INTO agents (name, capabilities, pid, state, last_seen)
		VALUES (?, 'fs:read,fs:write,cmd:run', 0, COALESCE(NULLIF(?, ''), 'idle'), ?)
		ON CONFLICT(name) DO UPDATE SET
			state = COALESCE(NULLIF(excluded.state, ''), agents.state),
			last_seen = excluded.last_seen
	`, name, state, nowMS())
	return err
}

// SetAgentState updates one agent's state and heartbeat.
func (d *DB) SetAgentState(name, state string) error {
	res, err := d.conn.Exec(`UPDATE agents SET state = ?, last_seen = ? WHERE name = ?`, state, nowMS(), name)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return sql.ErrNoRows
	}
	return nil
}

// GetAgent returns one registered agent.
func (d *DB) GetAgent(name string) (*Agent, error) {
	row := d.conn.QueryRow(`SELECT name, capabilities, COALESCE(pid, 0), COALESCE(state, 'idle'), last_seen FROM agents WHERE name = ?`, name)
	var (
		a        Agent
		lastSeen int64
	)
	if err := row.Scan(&a.Name, &a.Capabilities, &a.PID, &a.State, &lastSeen); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, sql.ErrNoRows
		}
		return nil, err
	}
	a.LastSeen = msToTime(lastSeen)
	return &a, nil
}

// ListAgents lists registered agents by name.
func (d *DB) ListAgents() ([]Agent, error) {
	rows, err := d.conn.Query(`SELECT name, capabilities, COALESCE(pid, 0), COALESCE(state, 'idle'), last_seen FROM agents ORDER BY name ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Agent
	for rows.Next() {
		var (
			a        Agent
			lastSeen int64
		)
		if err := rows.Scan(&a.Name, &a.Capabilities, &a.PID, &a.State, &lastSeen); err != nil {
			return nil, err
		}
		a.LastSeen = msToTime(lastSeen)
		out = append(out, a)
	}
	return out, rows.Err()
}

// GetCursor returns an agent's read cursor for a thread (0 when unset).
func (d *DB) GetCursor(agent, thread string) (int64, error) {
	var cursor int64
	err := d.conn.QueryRow(`SELECT cursor_index FROM agent_cursors WHERE agent_name = ? AND thread = ?`, agent, thread).Scan(&cursor)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return cursor, err
}

// SetCursor stores an agent's read cursor, never moving it backwards.
func (d *DB) SetCursor(agent, thread string, cursor int64) error {
	_, err := d.conn.Exec(`
		INSERT INTO agent_cursors (agent_name, thread, cursor_index)
		VALUES (?, ?, ?)
		ON CONFLICT(agent_name, thread) DO UPDATE SET cursor_index = MAX(agent_cursors.cursor_index, excluded.cursor_index)
	`, agent, thread, cursor)
	return err
}

// UnreadMentions counts mentions of agent (or @all) after its cursor.
func (d *DB) UnreadMentions(agent, thread string) (int, error) {
	cursor, err := d.GetCursor(agent, thread)
	if err != nil {
		return 0, err
	}
	var n int
	err = d.conn.QueryRow(`
		SELECT COUNT(*) FROM events
		WHERE thread = ? AND id > ? AND (mentions LIKE ? OR mentions LIKE ?)
	`, thread, cursor, "%,@"+strings.ToLower(strings.TrimPrefix(agent, "@"))+",%", "%,@all,%").Scan(&n)
	return n, err
}

func quoteIdent(s string) string {
	return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
}

const schemaV2 = `
CREATE TABLE IF NOT EXISTS events (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	channel TEXT NOT NULL,
	thread TEXT NOT NULL,
	actor_id TEXT NOT NULL,
	event_type TEXT NOT NULL,
	content TEXT NOT NULL,
	mentions TEXT NOT NULL DEFAULT '',
	slice_ref TEXT,
	created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
	id TEXT PRIMARY KEY,
	channel TEXT NOT NULL,
	thread TEXT NOT NULL,
	title TEXT NOT NULL,
	contract_interface TEXT NOT NULL DEFAULT '',
	required_caps TEXT NOT NULL DEFAULT '',
	depends_on TEXT NOT NULL DEFAULT '',
	state TEXT NOT NULL DEFAULT 'queued',
	owner TEXT,
	lease_until INTEGER,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS file_locks (
	lock_key TEXT PRIMARY KEY,
	file_path TEXT NOT NULL,
	owner_task TEXT NOT NULL DEFAULT '',
	owner_agent TEXT NOT NULL,
	acquired_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_cursors (
	agent_name TEXT NOT NULL,
	thread TEXT NOT NULL,
	cursor_index INTEGER DEFAULT 0,
	PRIMARY KEY (agent_name, thread)
);

CREATE TABLE IF NOT EXISTS agents (
	name TEXT PRIMARY KEY,
	capabilities TEXT NOT NULL DEFAULT '',
	pid INTEGER,
	state TEXT DEFAULT 'idle',
	last_seen INTEGER NOT NULL
);
`

const indexV2 = `
CREATE INDEX IF NOT EXISTS idx_events_thread_id ON events(thread, id);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_thread_state ON tasks(thread, state);
CREATE INDEX IF NOT EXISTS idx_locks_agent ON file_locks(owner_agent);
`
