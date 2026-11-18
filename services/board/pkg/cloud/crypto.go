package cloud

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"strings"
)

// Snapshot files are encrypted before they leave the machine: AES-256-GCM with
// a key derived from the operator's passphrase with PBKDF2-SHA256.
const (
	// snapshotMagic versions the envelope and is authenticated with the data.
	snapshotMagic      = "ABPENC1\x00"
	snapshotSaltLen    = 16
	snapshotNonceLen   = 12
	snapshotKeyLen     = 32
	snapshotIterations = 210_000
)

var (
	// ErrPassphraseRequired means an encrypted upload was attempted without a key.
	ErrPassphraseRequired = errors.New("snapshot encryption requires OPEN_BOARD_SNAPSHOT_PASSPHRASE")
	// ErrNotEncrypted means the data is not an encrypted snapshot envelope.
	ErrNotEncrypted = errors.New("not an encrypted open-agent-board snapshot")
)

// EncryptSnapshot seals plain snapshot bytes into a self-contained envelope:
// magic, salt, nonce, then AES-256-GCM ciphertext.
func EncryptSnapshot(passphrase string, plain []byte) ([]byte, error) {
	if strings.TrimSpace(passphrase) == "" {
		return nil, ErrPassphraseRequired
	}
	salt := make([]byte, snapshotSaltLen)
	if _, err := io.ReadFull(rand.Reader, salt); err != nil {
		return nil, fmt.Errorf("snapshot salt: %w", err)
	}
	key, err := snapshotKey(passphrase, salt)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, snapshotNonceLen)
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, fmt.Errorf("snapshot nonce: %w", err)
	}

	out := make([]byte, 0, len(snapshotMagic)+snapshotSaltLen+snapshotNonceLen+len(plain)+gcm.Overhead())
	out = append(out, snapshotMagic...)
	out = append(out, salt...)
	out = append(out, nonce...)
	out = gcm.Seal(out, nonce, plain, []byte(snapshotMagic))
	return out, nil
}

// DecryptSnapshot opens an envelope produced by EncryptSnapshot. It fails with
// ErrNotEncrypted for foreign or truncated data and returns a decryption error
// for a wrong passphrase or a damaged ciphertext.
func DecryptSnapshot(passphrase string, data []byte) ([]byte, error) {
	if strings.TrimSpace(passphrase) == "" {
		return nil, ErrPassphraseRequired
	}
	header := len(snapshotMagic) + snapshotSaltLen + snapshotNonceLen
	if len(data) < header+16 || !bytes.HasPrefix(data, []byte(snapshotMagic)) {
		return nil, ErrNotEncrypted
	}
	salt := data[len(snapshotMagic) : len(snapshotMagic)+snapshotSaltLen]
	nonce := data[len(snapshotMagic)+snapshotSaltLen : header]
	key, err := snapshotKey(passphrase, salt)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	plain, err := gcm.Open(nil, nonce, data[header:], []byte(snapshotMagic))
	if err != nil {
		return nil, fmt.Errorf("snapshot decryption failed (wrong passphrase or damaged file): %w", err)
	}
	return plain, nil
}

func snapshotKey(passphrase string, salt []byte) ([]byte, error) {
	key, err := pbkdf2.Key(sha256.New, passphrase, salt, snapshotIterations, snapshotKeyLen)
	if err != nil {
		return nil, fmt.Errorf("derive snapshot key: %w", err)
	}
	return key, nil
}
