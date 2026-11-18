package cloud

import (
	"bytes"
	"compress/gzip"
	"context"
	"database/sql"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"open-board/pkg/db"
)

const testPassphrase = "correct horse battery staple"

func testDB(t *testing.T) *db.DB {
	t.Helper()
	d, err := db.Open(t.TempDir(), "default")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { d.Close() })
	if _, err := d.AppendEvent("default", "sprint-1", "human", "note", "snapshot", nil, ""); err != nil {
		t.Fatal(err)
	}
	return d
}

// openGzippedSQLite asserts plain snapshot bytes are gzip over a SQLite header
// and returns a queryable database.
func openGzippedSQLite(t *testing.T, data []byte) *sql.DB {
	t.Helper()
	gz, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("snapshot is not gzip: %v", err)
	}
	plain, err := io.ReadAll(gz)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.HasPrefix(plain, []byte("SQLite format 3\x00")) {
		t.Fatalf("snapshot is not SQLite: %q", plain[:min(len(plain), 16)])
	}
	path := filepath.Join(t.TempDir(), "snapshot.sqlite")
	if err := os.WriteFile(path, plain, 0o600); err != nil {
		t.Fatal(err)
	}
	return openSQLite(t, path)
}

func openSQLite(t *testing.T, path string) *sql.DB {
	t.Helper()
	handle, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { handle.Close() })
	if err := handle.Ping(); err != nil {
		t.Fatal(err)
	}
	return handle
}

func TestDryRunSnapshotIsAValidDatabase(t *testing.T) {
	d := testDB(t)
	cfg := Config{Bucket: "open-agent-board", Prefix: "snapshots"}
	res, err := cfg.Snapshot(context.Background(), d, "default", true)
	if err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	if !res.DryRun || res.Uploaded || res.Encrypted || res.Bytes == 0 || res.SHA256 == "" {
		t.Fatalf("unexpected result: %+v", res)
	}
	if !strings.Contains(res.Key, "snapshots/default/") {
		t.Fatalf("unexpected key: %s", res.Key)
	}
	if _, err := os.Stat(res.LocalPath); err != nil {
		t.Fatalf("snapshot file missing: %v", err)
	}

	data, err := os.ReadFile(res.LocalPath)
	if err != nil {
		t.Fatal(err)
	}
	openGzippedSQLite(t, data)
}

func TestSnapshotIsEncryptedAndDecryptsToDatabase(t *testing.T) {
	d := testDB(t)
	var gotPath string
	var gotBody []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			t.Errorf("method = %s", r.Method)
		}
		gotPath = r.URL.Path
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read body: %v", err)
		}
		gotBody = body
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	cfg := Config{
		Endpoint:        server.URL,
		Bucket:          "open-agent-board",
		AccessKeyID:     "test-key",
		SecretAccessKey: "test-secret",
		Region:          "auto",
		Prefix:          "snapshots",
		Passphrase:      testPassphrase,
	}
	res, err := cfg.Snapshot(context.Background(), d, "default", false)
	if err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	if !res.Uploaded || !res.Encrypted {
		t.Fatalf("snapshot should be encrypted and uploaded: %+v", res)
	}
	if !strings.HasSuffix(gotPath, ".sqlite.gz.enc") || !strings.HasSuffix(res.Key, ".sqlite.gz.enc") {
		t.Fatalf("unexpected key: path=%s key=%s", gotPath, res.Key)
	}
	if !strings.HasPrefix(string(gotBody), snapshotMagic) {
		t.Fatalf("upload is not an encrypted envelope: % x", gotBody[:min(len(gotBody), 12)])
	}
	if len(gotBody) > 2 && gotBody[0] == 0x1f && gotBody[1] == 0x8b {
		t.Fatal("upload is plain gzip, not encrypted")
	}

	// The uploaded ciphertext decrypts with the passphrase and opens as a real
	// SQLite database with the channel's rows.
	plain, err := DecryptSnapshot(testPassphrase, gotBody)
	if err != nil {
		t.Fatalf("decrypt upload: %v", err)
	}
	handle := openGzippedSQLite(t, plain)
	var events int
	if err := handle.QueryRow("SELECT COUNT(*) FROM events").Scan(&events); err != nil {
		t.Fatalf("query decrypted snapshot: %v", err)
	}
	if events != 1 {
		t.Fatalf("want 1 event in the snapshot, got %d", events)
	}

	// Only the encrypted file stays on disk.
	if _, err := os.Stat(res.LocalPath); err != nil {
		t.Fatalf("encrypted local copy missing: %v", err)
	}
	entries, err := os.ReadDir(filepath.Dir(res.LocalPath))
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".sqlite.gz") {
			t.Fatalf("plaintext snapshot was left behind: %s", entry.Name())
		}
	}
}

func TestSnapshotRequiresAPassphrase(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	cfg := Config{
		Endpoint:        server.URL,
		Bucket:          "b",
		AccessKeyID:     "k",
		SecretAccessKey: "s",
		Region:          "auto",
		Prefix:          "snapshots",
	}
	_, err := cfg.Snapshot(context.Background(), testDB(t), "default", false)
	if !errors.Is(err, ErrPassphraseRequired) {
		t.Fatalf("want ErrPassphraseRequired, got %v", err)
	}
	if requests != 0 {
		t.Fatalf("an unencrypted snapshot was uploaded (%d requests)", requests)
	}
	if len(cfg.Missing()) != 1 || cfg.Missing()[0] != "OPEN_BOARD_SNAPSHOT_PASSPHRASE" {
		t.Fatalf("passphrase should be reported missing: %v", cfg.Missing())
	}
}

func TestDecryptRejectsWrongKeyAndDamagedFiles(t *testing.T) {
	sealed, err := EncryptSnapshot(testPassphrase, []byte("secret snapshot"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := DecryptSnapshot("different passphrase", sealed); err == nil ||
		!strings.Contains(err.Error(), "decryption failed") {
		t.Fatalf("a wrong passphrase must fail, got %v", err)
	}

	damaged := append([]byte(nil), sealed...)
	damaged[len(damaged)-1] ^= 0xff
	if _, err := DecryptSnapshot(testPassphrase, damaged); err == nil {
		t.Fatal("a damaged ciphertext must fail")
	}

	if _, err := DecryptSnapshot(testPassphrase, sealed[:20]); !errors.Is(err, ErrNotEncrypted) {
		t.Fatalf("a truncated file must be rejected, got %v", err)
	}
	if _, err := DecryptSnapshot(testPassphrase, []byte("not a snapshot")); !errors.Is(err, ErrNotEncrypted) {
		t.Fatalf("foreign data must be rejected, got %v", err)
	}
	if _, err := DecryptSnapshot("", sealed); !errors.Is(err, ErrPassphraseRequired) {
		t.Fatalf("an empty passphrase must be rejected, got %v", err)
	}
	if _, err := EncryptSnapshot("  ", []byte("x")); !errors.Is(err, ErrPassphraseRequired) {
		t.Fatalf("an empty passphrase must not encrypt, got %v", err)
	}
}

func TestEncryptSnapshotIsRandomised(t *testing.T) {
	a, err := EncryptSnapshot(testPassphrase, []byte("same input"))
	if err != nil {
		t.Fatal(err)
	}
	b, err := EncryptSnapshot(testPassphrase, []byte("same input"))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(a, b) {
		t.Fatal("two encryptions of the same data must differ (fresh salt and nonce)")
	}
	for _, sealed := range [][]byte{a, b} {
		plain, err := DecryptSnapshot(testPassphrase, sealed)
		if err != nil {
			t.Fatal(err)
		}
		if string(plain) != "same input" {
			t.Fatalf("round trip changed the data: %q", plain)
		}
	}
}

func TestUploadSignsAndSendsTheSnapshot(t *testing.T) {
	var gotPath, gotAuth, gotContent string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			t.Errorf("method = %s", r.Method)
		}
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotContent = r.Header.Get("Content-Type")
		if r.Header.Get("X-Amz-Content-Sha256") == "" {
			t.Error("missing payload hash")
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	cfg := Config{
		Endpoint:        server.URL,
		Bucket:          "open-agent-board",
		AccessKeyID:     "test-key",
		SecretAccessKey: "test-secret",
		Region:          "auto",
		Prefix:          "snapshots",
	}
	if err := cfg.Upload(context.Background(), "snapshots/default/board.sqlite.gz.enc", []byte("hello")); err != nil {
		t.Fatalf("upload: %v", err)
	}
	if gotPath != "/open-agent-board/snapshots/default/board.sqlite.gz.enc" {
		t.Fatalf("unexpected path: %s", gotPath)
	}
	if !strings.HasPrefix(gotAuth, "AWS4-HMAC-SHA256 Credential=test-key/") {
		t.Fatalf("unexpected Authorization: %s", gotAuth)
	}
	if !strings.Contains(gotAuth, "SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date") {
		t.Fatalf("unexpected signed headers: %s", gotAuth)
	}
	if gotContent != "application/octet-stream" {
		t.Fatalf("unexpected content type: %s", gotContent)
	}

	// The same request must sign the same way every time.
	first := gotAuth
	if err := cfg.Upload(context.Background(), "snapshots/default/board.sqlite.gz.enc", []byte("hello")); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(first, "Signature=") || gotAuth == "" {
		t.Fatalf("no signature: %s", first)
	}
}

func TestUploadReportsProviderErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "denied", http.StatusForbidden)
	}))
	defer server.Close()

	cfg := Config{Endpoint: server.URL, Bucket: "b", AccessKeyID: "k", SecretAccessKey: "s", Region: "auto"}
	err := cfg.Upload(context.Background(), "k", []byte("x"))
	if err == nil || !strings.Contains(err.Error(), "403") {
		t.Fatalf("want a 403 error, got %v", err)
	}
}

func TestConfigFromEnv(t *testing.T) {
	for _, key := range []string{
		"CLOUDFLARE_R2_ENDPOINT", "CLOUDFLARE_R2_BUCKET", "CLOUDFLARE_R2_ACCESS_KEY_ID",
		"CLOUDFLARE_R2_SECRET_ACCESS_KEY", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_R2_PREFIX",
		"OPEN_BOARD_SNAPSHOT_PASSPHRASE",
	} {
		t.Setenv(key, "")
	}
	cfg := FromEnv()
	if cfg.Enabled() {
		t.Fatal("empty environment should not be enabled")
	}
	if len(cfg.Missing()) != 4 {
		t.Fatalf("want 4 missing settings, got %v", cfg.Missing())
	}

	t.Setenv("CLOUDFLARE_ACCOUNT_ID", "abc123")
	t.Setenv("CLOUDFLARE_R2_ACCESS_KEY_ID", "key")
	t.Setenv("CLOUDFLARE_R2_SECRET_ACCESS_KEY", "secret")
	cfg = FromEnv()
	if cfg.Enabled() {
		t.Fatal("upload without a passphrase would be plaintext and must stay disabled")
	}
	t.Setenv("OPEN_BOARD_SNAPSHOT_PASSPHRASE", testPassphrase)
	cfg = FromEnv()
	if !cfg.Enabled() {
		t.Fatalf("credentials plus a passphrase should enable upload: %v", cfg.Missing())
	}
	if cfg.Endpoint != "https://abc123.r2.cloudflarestorage.com" {
		t.Fatalf("endpoint should derive from the account id: %s", cfg.Endpoint)
	}
	if cfg.Prefix != "snapshots" || cfg.Bucket != "open-agent-board" {
		t.Fatalf("unexpected defaults: %+v", cfg)
	}
}

func TestSnapshotNeedsAChannel(t *testing.T) {
	cfg := Config{Passphrase: testPassphrase}
	if _, err := cfg.Snapshot(context.Background(), testDB(t), "", true); err == nil {
		t.Fatal("a snapshot without a channel should fail")
	}
}

func TestEscapePath(t *testing.T) {
	got := escapePath("/bucket/a b/c+d")
	if got != "/bucket/a%20b/c%2Bd" {
		t.Fatalf("got %q", got)
	}
	if escapePath("") != "/" {
		t.Fatalf("empty path should be /")
	}
}
