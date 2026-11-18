// Package cloud syncs a channel's database to Cloudflare R2 as immutable,
// encrypted snapshots, signed with AWS Signature Version 4. Credentials come
// from the environment and are never stored in the repository.
package cloud

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"open-board/pkg/db"
)

// Config is everything a snapshot upload needs.
type Config struct {
	Endpoint        string
	Bucket          string
	AccessKeyID     string
	SecretAccessKey string
	Region          string
	Prefix          string
	Webhook         string
	Passphrase      string
	Client          *http.Client
}

// FromEnv reads the Cloudflare settings the architecture documents:
// CLOUDFLARE_R2_ENDPOINT, CLOUDFLARE_R2_BUCKET, CLOUDFLARE_R2_ACCESS_KEY_ID,
// CLOUDFLARE_R2_SECRET_ACCESS_KEY, and optionally CLOUDFLARE_ACCOUNT_ID,
// CLOUDFLARE_R2_REGION, CLOUDFLARE_R2_PREFIX, CLOUDFLARE_SYNC_WEBHOOK and
// OPEN_BOARD_SNAPSHOT_PASSPHRASE.
func FromEnv() Config {
	endpoint := strings.TrimRight(os.Getenv("CLOUDFLARE_R2_ENDPOINT"), "/")
	if endpoint == "" {
		if account := os.Getenv("CLOUDFLARE_ACCOUNT_ID"); account != "" {
			endpoint = "https://" + account + ".r2.cloudflarestorage.com"
		}
	}
	c := Config{
		Endpoint:        endpoint,
		Bucket:          envOr("CLOUDFLARE_R2_BUCKET", "open-agent-board"),
		AccessKeyID:     os.Getenv("CLOUDFLARE_R2_ACCESS_KEY_ID"),
		SecretAccessKey: os.Getenv("CLOUDFLARE_R2_SECRET_ACCESS_KEY"),
		Region:          envOr("CLOUDFLARE_R2_REGION", "auto"),
		Prefix:          envOr("CLOUDFLARE_R2_PREFIX", "snapshots"),
		Webhook:         os.Getenv("CLOUDFLARE_SYNC_WEBHOOK"),
		Passphrase:      os.Getenv("OPEN_BOARD_SNAPSHOT_PASSPHRASE"),
	}
	return c
}

func envOr(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

// Missing lists the settings a real upload still needs.
func (c Config) Missing() []string {
	var missing []string
	if c.Endpoint == "" {
		missing = append(missing, "CLOUDFLARE_R2_ENDPOINT")
	}
	if c.Bucket == "" {
		missing = append(missing, "CLOUDFLARE_R2_BUCKET")
	}
	if c.AccessKeyID == "" {
		missing = append(missing, "CLOUDFLARE_R2_ACCESS_KEY_ID")
	}
	if c.SecretAccessKey == "" {
		missing = append(missing, "CLOUDFLARE_R2_SECRET_ACCESS_KEY")
	}
	if strings.TrimSpace(c.Passphrase) == "" {
		missing = append(missing, "OPEN_BOARD_SNAPSHOT_PASSPHRASE")
	}
	return missing
}

// Enabled reports whether a real upload is possible.
func (c Config) Enabled() bool { return len(c.Missing()) == 0 }

// Result describes a snapshot.
type Result struct {
	Channel   string `json:"channel"`
	Key       string `json:"key,omitempty"`
	URL       string `json:"url,omitempty"`
	LocalPath string `json:"local_path"`
	Bytes     int64  `json:"bytes"`
	SHA256    string `json:"sha256"`
	Encrypted bool   `json:"encrypted"`
	DryRun    bool   `json:"dry_run"`
	Uploaded  bool   `json:"uploaded"`
}

// Snapshot writes a gzipped copy of the channel's database beside it, encrypts
// that copy with AES-256-GCM, and uploads the encrypted envelope to R2. A dry
// run stops after the local gzip file, which never leaves the machine.
func (c Config) Snapshot(ctx context.Context, database *db.DB, channel string, dryRun bool) (Result, error) {
	if channel == "" {
		return Result{}, fmt.Errorf("channel is required")
	}
	if !dryRun && strings.TrimSpace(c.Passphrase) == "" {
		return Result{}, ErrPassphraseRequired
	}
	if !dryRun && !c.Enabled() {
		return Result{}, fmt.Errorf("snapshot upload is not configured: missing %s", strings.Join(c.Missing(), ", "))
	}
	snapDir := filepath.Join(filepath.Dir(database.Path()), "snapshots")
	if err := os.MkdirAll(snapDir, 0o755); err != nil {
		return Result{}, err
	}
	stamp := time.Now().UTC().Format("20060102T150405Z")
	base := fmt.Sprintf("%s-%s.sqlite.gz", sanitize(channel), stamp)
	localPath := filepath.Join(snapDir, base)

	tmp, err := os.CreateTemp(snapDir, "snapshot-*.sqlite")
	if err != nil {
		return Result{}, err
	}
	tmpPath := tmp.Name()
	tmp.Close()
	defer os.Remove(tmpPath)

	if err := database.SnapshotTo(tmpPath); err != nil {
		return Result{}, fmt.Errorf("snapshot database: %w", err)
	}

	raw, err := os.Open(tmpPath)
	if err != nil {
		return Result{}, err
	}
	defer raw.Close()

	out, err := os.Create(localPath)
	if err != nil {
		return Result{}, err
	}
	gz, _ := gzip.NewWriterLevel(out, gzip.BestCompression)
	if _, err := io.Copy(gz, raw); err != nil {
		out.Close()
		return Result{}, err
	}
	if err := gz.Close(); err != nil {
		out.Close()
		return Result{}, err
	}
	if err := out.Close(); err != nil {
		return Result{}, err
	}

	data, err := os.ReadFile(localPath)
	if err != nil {
		return Result{}, err
	}
	key := fmt.Sprintf("%s/%s/%s", strings.Trim(c.Prefix, "/"), channel, base)

	res := Result{
		Channel:   channel,
		Key:       key,
		LocalPath: localPath,
		DryRun:    dryRun,
	}
	if dryRun {
		sum := sha256.Sum256(data)
		res.Bytes = int64(len(data))
		res.SHA256 = hex.EncodeToString(sum[:])
		return res, nil
	}

	sealed, err := EncryptSnapshot(c.Passphrase, data)
	if err != nil {
		os.Remove(localPath)
		return Result{}, err
	}
	// Do not leave the plaintext copy beside an encrypted upload.
	if err := os.Remove(localPath); err != nil {
		return Result{}, err
	}
	localPath += ".enc"
	if err := os.WriteFile(localPath, sealed, 0o600); err != nil {
		return Result{}, err
	}
	key += ".enc"

	sum := sha256.Sum256(sealed)
	res.Key = key
	res.LocalPath = localPath
	res.Bytes = int64(len(sealed))
	res.SHA256 = hex.EncodeToString(sum[:])
	res.Encrypted = true

	if err := c.Upload(ctx, key, sealed); err != nil {
		return res, err
	}
	res.Uploaded = true
	res.URL = c.Endpoint + "/" + c.Bucket + "/" + escapePath(key)
	c.notify(ctx, res)
	return res, nil
}

// Upload PUTs data at key in the configured bucket.
func (c Config) Upload(ctx context.Context, key string, data []byte) error {
	endpoint, err := url.Parse(c.Endpoint)
	if err != nil {
		return fmt.Errorf("parse CLOUDFLARE_R2_ENDPOINT: %w", err)
	}
	path := "/" + strings.Trim(escapePath(c.Bucket), "/") + "/" + strings.Trim(escapePath(key), "/")
	target := endpoint.Scheme + "://" + endpoint.Host + path

	req, err := http.NewRequestWithContext(ctx, http.MethodPut, target, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.ContentLength = int64(len(data))
	req.Header.Set("Content-Type", "application/octet-stream")
	sign(req, data, c, time.Now().UTC())

	client := c.Client
	if client == nil {
		client = &http.Client{Timeout: 90 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("upload to R2: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return fmt.Errorf("R2 answered %s: %s", resp.Status, strings.TrimSpace(string(body)))
	}
	return nil
}

func (c Config) notify(ctx context.Context, res Result) {
	if c.Webhook == "" {
		return
	}
	payload, err := json.Marshal(res)
	if err != nil {
		return
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.Webhook, bytes.NewReader(payload))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	client := c.Client
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}
	resp, err := client.Do(req)
	if err == nil {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
	}
}

func sanitize(name string) string {
	var b strings.Builder
	for _, r := range name {
		if r == '.' || r == '-' || r == '_' || r >= '0' && r <= '9' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' {
			b.WriteRune(r)
		} else {
			b.WriteByte('-')
		}
	}
	return b.String()
}

// sign applies AWS Signature Version 4 for R2's S3 API.
func sign(req *http.Request, payload []byte, c Config, now time.Time) {
	amzDate := now.Format("20060102T150405Z")
	dateStamp := now.Format("20060102")
	sum := sha256.Sum256(payload)
	payloadHash := hex.EncodeToString(sum[:])

	req.Header.Set("X-Amz-Date", amzDate)
	req.Header.Set("X-Amz-Content-Sha256", payloadHash)

	region := c.Region
	if region == "" {
		region = "auto"
	}
	scope := strings.Join([]string{dateStamp, region, "s3", "aws4_request"}, "/")

	canonicalHeaders := strings.Join([]string{
		"content-type:" + strings.TrimSpace(req.Header.Get("Content-Type")),
		"host:" + req.URL.Host,
		"x-amz-content-sha256:" + payloadHash,
		"x-amz-date:" + amzDate,
	}, "\n") + "\n"
	signedHeaders := "content-type;host;x-amz-content-sha256;x-amz-date"

	canonicalRequest := strings.Join([]string{
		req.Method,
		escapePath(req.URL.Path),
		"",
		canonicalHeaders,
		signedHeaders,
		payloadHash,
	}, "\n")

	requestHash := sha256.Sum256([]byte(canonicalRequest))
	stringToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256",
		amzDate,
		scope,
		hex.EncodeToString(requestHash[:]),
	}, "\n")

	key := hmacSHA256([]byte("AWS4"+c.SecretAccessKey), dateStamp)
	key = hmacSHA256(key, region)
	key = hmacSHA256(key, "s3")
	key = hmacSHA256(key, "aws4_request")
	signature := hex.EncodeToString(hmacSHA256(key, stringToSign))

	req.Header.Set("Authorization", fmt.Sprintf(
		"AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s",
		c.AccessKeyID, scope, signedHeaders, signature))
}

func hmacSHA256(key []byte, data string) []byte {
	h := hmac.New(sha256.New, key)
	h.Write([]byte(data))
	return h.Sum(nil)
}

// escapePath percent-encodes each path segment as SigV4 requires.
func escapePath(path string) string {
	if path == "" {
		return "/"
	}
	var b strings.Builder
	for _, seg := range strings.Split(path, "/") {
		if seg == "" {
			continue
		}
		b.WriteByte('/')
		for i := 0; i < len(seg); i++ {
			ch := seg[i]
			if ch >= 'A' && ch <= 'Z' || ch >= 'a' && ch <= 'z' || ch >= '0' && ch <= '9' || ch == '-' || ch == '_' || ch == '.' || ch == '~' {
				b.WriteByte(ch)
			} else {
				fmt.Fprintf(&b, "%%%02X", ch)
			}
		}
	}
	if b.Len() == 0 {
		return "/"
	}
	return b.String()
}
