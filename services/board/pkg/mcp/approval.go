package mcp

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"sync"
	"time"
)

// WriteTools is the set of tools that change the board. Everything else reads.
//
// The list is the whole policy: a tool in here cannot reach the API without an approval token,
// and a tool outside it cannot be made to need one by a caller. Keeping it a package-level list
// rather than a per-call flag means adding a tool forces the decision to be made once.
var WriteTools = map[string]bool{
	"board_post":   true,
	"board_claim":  true,
	"board_done":   true,
	"board_lock":   true,
	"board_unlock": true,
	// A connector call can change a system outside this board, so it costs the same
	// approval as a board write: show the call, then run it with the token.
	"board_connector_call": true,
}

// IsWrite reports whether a tool changes board state.
func IsWrite(name string) bool { return WriteTools[name] }

// Approval issues and checks the single-use tokens that authorise a write.
//
// An MCP server is a tool provider: the model decides to call it and the call lands. For a write
// that is too much trust, so a write is a two-step exchange. The first call is not performed —
// it returns a token and the exact action that would be taken, which the client shows to the
// person. If they agree, the same call is repeated with `confirm: <token>` and it lands.
//
// The token is an HMAC over the tool name and its arguments, so it cannot be replayed against
// different arguments, and it is remembered until used, so it cannot be replayed twice.
type Approval struct {
	secret []byte
	ttl    time.Duration
	now    func() time.Time

	mu     sync.Mutex
	tokens map[string]time.Time // token → expiry
	order  []string             // insertion order, so the cap evicts the oldest
}

// maxPendingTokens bounds the memory a client can make us hold by asking for tokens it never uses.
const maxPendingTokens = 256

// NewApproval returns an approver whose tokens live for ttl. A ttl of zero means five minutes:
// long enough for a person to read the action and answer, short enough that a stale token from a
// conversation resumed tomorrow is dead.
func NewApproval(ttl time.Duration) *Approval {
	if ttl <= 0 {
		ttl = 5 * time.Minute
	}
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		// crypto/rand failing is not something to paper over: without a secret the tokens
		// would be guessable, so panic here is the honest outcome. It does not happen on any
		// platform this runs on.
		panic("mcp: cannot read randomness for approval tokens: " + err.Error())
	}
	return &Approval{secret: secret, ttl: ttl, now: time.Now, tokens: map[string]time.Time{}}
}

func canonicalValue(value any) string {
	var build func(any) string
	build = func(v any) string {
		switch typed := v.(type) {
		case map[string]any:
			keys := make([]string, 0, len(typed))
			for key := range typed {
				keys = append(keys, key)
			}
			sort.Strings(keys)
			out := "{"
			for i, key := range keys {
				if i > 0 {
					out += ","
				}
				out += fmt.Sprintf("%q:%s", key, build(typed[key]))
			}
			return out + "}"
		case []any:
			out := "["
			for i, item := range typed {
				if i > 0 {
					out += ","
				}
				out += build(item)
			}
			return out + "]"
		default:
			data, _ := json.Marshal(typed)
			return string(data)
		}
	}
	return build(value)
}

// subject is what a token authorises: the arguments themselves, never the token. Without this, the
// approved repeat — the same call plus `confirm` — would hash differently from the call that was
// challenged, and no token could ever be used.
func subject(raw json.RawMessage) string {
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return string(raw)
	}
	if fields, ok := value.(map[string]any); ok {
		delete(fields, "confirm")
	}
	return canonicalValue(value)
}

func (a *Approval) sign(tool string, raw json.RawMessage) string {
	mac := hmac.New(sha256.New, a.secret)
	mac.Write([]byte(tool))
	mac.Write([]byte{0})
	mac.Write([]byte(subject(raw)))
	return hex.EncodeToString(mac.Sum(nil)[:16])
}

// Issue returns a token for this exact call, after dropping anything that has expired.
func (a *Approval) Issue(tool string, raw json.RawMessage) string {
	token := a.sign(tool, raw)
	now := a.now()

	a.mu.Lock()
	defer a.mu.Unlock()
	for len(a.order) >= maxPendingTokens {
		oldest := a.order[0]
		a.order = a.order[1:]
		delete(a.tokens, oldest)
	}
	if _, seen := a.tokens[token]; !seen {
		a.order = append(a.order, token)
	}
	a.tokens[token] = now.Add(a.ttl)
	return token
}

// Consume validates and burns a token. It is false for a token issued for other arguments, one
// that has expired, and one that has already been used.
func (a *Approval) Consume(tool string, raw json.RawMessage, token string) bool {
	expected := a.sign(tool, raw)
	if subtle.ConstantTimeCompare([]byte(expected), []byte(token)) != 1 {
		return false
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	expiry, seen := a.tokens[token]
	if !seen {
		return false
	}
	delete(a.tokens, token)
	if a.now().After(expiry) {
		return false
	}
	return true
}

// Pending reports how many unexpired tokens are outstanding, for the tests and for a log line.
func (a *Approval) Pending() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	now := a.now()
	count := 0
	for _, expiry := range a.tokens {
		if now.Before(expiry) {
			count++
		}
	}
	return count
}

// gateWrite decides whether a tool call may reach the API.
//
// It returns (text, true, nil) when the call must not be made: either the bridge is read-only, or
// the caller still has to approve it. The second return value exists so `callTool` can answer
// without branching on an error for what is a normal, expected step.
func gateWrite(name string, raw json.RawMessage, opts Options) (string, bool, error) {
	if !IsWrite(name) {
		return "", false, nil
	}
	if opts.ReadOnly {
		return "", true, fmt.Errorf("the board bridge is read-only (unset OPEN_BOARD_MCP_READ_ONLY to allow writes)")
	}
	if opts.Approval == nil {
		return "", false, nil
	}

	var args struct {
		Confirm string `json:"confirm"`
	}
	// A bare string or an array is not a write this server understands; let the tool's own
	// decoding produce that error rather than a misleading "approval required".
	if err := json.Unmarshal(raw, &args); err != nil {
		return "", false, nil
	}
	if args.Confirm != "" {
		if !opts.Approval.Consume(name, raw, args.Confirm) {
			return "", true, fmt.Errorf(
				"that approval token is not valid for this call: it was issued for different arguments, has expired, or has already been used. Call %s again to get a fresh one", name)
		}
		return "", false, nil
	}

	token := opts.Approval.Issue(name, raw)
	// Echo the action back in a form the client can put in front of a person: the tool, the
	// arguments, and what it will change. The caller is expected to ask, not to guess.
	var echoed any
	_ = json.Unmarshal(raw, &echoed)
	payload := map[string]any{
		"approval_required":  true,
		"tool":               name,
		"arguments":          echoed,
		"confirm":            token,
		"expires_in_seconds": int(opts.Approval.ttl.Seconds()),
		"next":               fmt.Sprintf("Show this to the person and, if they agree, call %s again with the same arguments plus \"confirm\": %q.", name, token),
	}
	text, err := json.Marshal(payload)
	if err != nil {
		return "", true, err
	}
	return string(text), true, nil
}
