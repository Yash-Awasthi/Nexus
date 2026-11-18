// Package grammar parses the board's status-verb protocol: a verb, its
// argument, mentions, and the %*% slice relay.
package grammar

import (
	"fmt"
	"strings"
)

// WordCap is the hard limit for conversational events.
const WordCap = 200

var validVerbs = map[string]bool{
	"claim":       true,
	"working":     true,
	"done":        true,
	"stuck":       true,
	"help":        true,
	"failed":      true,
	"lock":        true,
	"unlock":      true,
	"review-ok":   true,
	"review-fail": true,
	"slice":       true,
	"ask":         true,
	"reply":       true,
	"note":        true,
}

// ParsedMessage is one validated board message.
type ParsedMessage struct {
	Verb        string   `json:"verb"`
	Argument    string   `json:"argument"`
	Raw         string   `json:"raw"`
	IsSlice     bool     `json:"is_slice"`
	SlicePath   string   `json:"slice_path,omitempty"`
	SliceTarget string   `json:"slice_target,omitempty"`
	Mentions    []string `json:"mentions,omitempty"`
	Words       int      `json:"words"`
}

// Verbs returns the protocol's verbs, in documentation order.
func Verbs() []string {
	return []string{"claim", "working", "done", "stuck", "help", "failed", "lock", "unlock", "review-ok", "review-fail", "slice", "ask", "reply"}
}

// ParseAndValidate parses a message and enforces the protocol. Plain prose
// without a status verb is accepted as a note; a malformed verb is rejected.
func ParseAndValidate(raw string) (*ParsedMessage, error) {
	msg := new(ParsedMessage)
	mentions := make([]string, 0, 4)
	if err := ParseAndValidateInto(raw, msg, mentions); err != nil {
		return nil, err
	}
	return msg, nil
}

// ParseAndValidateInto is the zero-allocation parser: it writes into dst and
// appends mentions to mentionBuf, so a caller that supplies both (a stack
// value and a fixed array) parses a message without touching the heap.
// mentionBuf must have enough spare capacity for the message's mentions; pass
// a slice with cap >= 16 to be safe. On error dst is left zeroed.
func ParseAndValidateInto(raw string, dst *ParsedMessage, mentionBuf []string) error {
	*dst = ParsedMessage{}
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return fmt.Errorf("message cannot be empty")
	}
	words := countWords(trimmed)
	dst.Raw = raw
	dst.Words = words

	// %*% <path> <symbol-or-lines>: a priority slice request, uncapped.
	if strings.HasPrefix(trimmed, "%*%") {
		rest := strings.TrimSpace(trimmed[len("%*%"):])
		if rest == "" {
			return fmt.Errorf("slice request needs a path: %%*%% <path> <symbol-or-lines>")
		}
		path, target := splitFirst(rest)
		dst.Verb = "slice"
		dst.Argument = rest
		dst.IsSlice = true
		dst.SlicePath = path
		dst.SliceTarget = target
		dst.Mentions = extractMentionsInto(raw, mentionBuf)
		return nil
	}

	first, rest := splitFirst(trimmed)
	verb := strings.ToLower(strings.TrimRight(first, ":!.,"))

	if !validVerbs[verb] {
		// A word with a protocol separator or a badge shape is a broken verb;
		// anything else is ordinary prose and lands as a note.
		if strings.Contains(first, ":") || strings.HasPrefix(first, "**") || isBadge(first) {
			return fmt.Errorf("invalid status verb %q; allowed verbs: %s", first, strings.Join(Verbs(), ", "))
		}
		verb = "note"
		rest = trimmed
	}

	if words > WordCap {
		return fmt.Errorf("rejected: message has %d words, over the %d-word cap; shorten it or request a %%*%% slice", words, WordCap)
	}

	if verb != "note" && rest == "" {
		return fmt.Errorf("%s: needs an argument, for example \"%s: <task-id>\"", verb, verb)
	}

	dst.Verb = verb
	dst.Argument = rest
	dst.IsSlice = verb == "slice"
	dst.Mentions = extractMentionsInto(raw, mentionBuf)
	return nil
}

// splitFirst splits on the first whitespace run without allocating.
func splitFirst(s string) (first, rest string) {
	i := 0
	for i < len(s) && !isSpaceByte(s[i]) {
		i++
	}
	first = s[:i]
	for i < len(s) && isSpaceByte(s[i]) {
		i++
	}
	return first, s[i:]
}

func isSpaceByte(b byte) bool {
	return b == ' ' || b == '\t' || b == '\n' || b == '\r' || b == '\v' || b == '\f'
}

// countWords counts whitespace-separated words without building a slice.
func countWords(s string) int {
	words := 0
	inWord := false
	for i := 0; i < len(s); i++ {
		if isSpaceByte(s[i]) {
			inWord = false
			continue
		}
		if !inWord {
			words++
			inWord = true
		}
	}
	return words
}

func isBadge(s string) bool {
	// "done]" or "claim)" read as a verb with a stray separator.
	return strings.HasSuffix(s, "]") || strings.HasSuffix(s, ")")
}

// ExtractMentions returns the distinct @mentions in a message, lowercase and
// including their @.
func ExtractMentions(raw string) []string {
	return extractMentionsInto(raw, nil)
}

// extractMentionsInto appends distinct lower-case mentions to buf. It scans
// linearly, so it needs no map; passing a buffer with spare capacity keeps the
// hot path allocation-free for lower-case mention names.
func extractMentionsInto(raw string, buf []string) []string {
	out := buf[:0]
	for i := 0; i < len(raw); i++ {
		if raw[i] != '@' {
			continue
		}
		if i > 0 && !isBoundary(raw[i-1]) {
			continue
		}
		j := i + 1
		for j < len(raw) && isNameByte(raw[j]) {
			j++
		}
		if j == i+1 {
			continue
		}
		// The substring already includes '@'; ToLower returns it unchanged when
		// it is already lower case, so the usual path copies nothing.
		name := strings.ToLower(raw[i:j])
		if !containsString(out, name) {
			out = append(out, name)
		}
		i = j - 1
	}
	return out
}

func containsString(list []string, want string) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}

func isBoundary(b byte) bool {
	switch b {
	case ' ', '\t', '\n', '\r', '(', '[', '{', ',', ';', ':', '"', '\'', '>', '<', '*':
		return true
	}
	return false
}

func isNameByte(b byte) bool {
	return b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z' || b >= '0' && b <= '9' || b == '_' || b == '-'
}

// TaskRef returns the leading task id of a verb's argument, if it has one.
func TaskRef(argument string) string {
	first, _ := splitFirst(strings.TrimSpace(argument))
	return strings.TrimRight(first, ":,;")
}
