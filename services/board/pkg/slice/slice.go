// Package slice extracts the smallest useful piece of a file for a %*% relay,
// so an agent can answer with code instead of a whole repository.
package slice

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// MaxBytes caps how much of a file is read for a slice.
const MaxBytes = 2 << 20

// MaxLines caps a symbol slice.
const MaxLines = 200

// Request is a parsed %*% relay: a path and either line numbers or a symbol.
type Request struct {
	Path   string
	Target string
}

// Parse reads "%*% <path> <symbol-or-lines>". A bare path is allowed; the
// target defaults to the first block.
func Parse(raw string) (Request, error) {
	trimmed := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(raw), "%*%"))
	if trimmed == "" {
		return Request{}, fmt.Errorf("slice needs a path: %%*%% <path> <symbol-or-lines>")
	}
	fields := strings.SplitN(trimmed, " ", 2)
	req := Request{Path: strings.TrimSpace(fields[0])}
	if len(fields) > 1 {
		req.Target = strings.TrimSpace(fields[1])
	}
	return req, nil
}

// Extract returns the requested slice as a fenced code block with a header.
func Extract(path, target string) (string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", fmt.Errorf("read %s: %w", path, err)
	}
	if info.IsDir() {
		return "", fmt.Errorf("%s is a directory", path)
	}
	if info.Size() > MaxBytes {
		return "", fmt.Errorf("%s is %d bytes, over the %d-byte slice limit", path, info.Size(), MaxBytes)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read %s: %w", path, err)
	}
	lines := strings.Split(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n")

	start, end, err := locate(lines, target)
	if err != nil {
		return "", err
	}
	if start < 1 {
		start = 1
	}
	if end > len(lines) {
		end = len(lines)
	}

	var b strings.Builder
	fmt.Fprintf(&b, "%s:%d-%d\n", filepath.ToSlash(path), start, end)
	b.WriteString("```" + language(path) + "\n")
	for i := start; i <= end; i++ {
		b.WriteString(lines[i-1])
		b.WriteByte('\n')
	}
	b.WriteString("```\n")
	return b.String(), nil
}

func locate(lines []string, target string) (int, int, error) {
	target = strings.TrimSpace(target)
	if target == "" {
		end := len(lines)
		if end > 60 {
			end = 60
		}
		return 1, end, nil
	}

	if start, end, ok := parseRange(target); ok {
		return start, end, nil
	}

	needle := strings.ToLower(target)
	best := -1
	for i, line := range lines {
		if !strings.Contains(strings.ToLower(line), needle) {
			continue
		}
		if best == -1 {
			best = i
		}
		if looksLikeDeclaration(line, needle) {
			best = i
			break
		}
	}
	if best == -1 {
		return 0, 0, fmt.Errorf("no line matching %q", target)
	}

	start := best + 1
	if start > 1 {
		start--
	}
	end := blockEnd(lines, best)
	if end == -1 {
		end = best + 60
	}
	if end > start+MaxLines {
		end = start + MaxLines
	}
	return start, end, nil
}

func parseRange(target string) (int, int, bool) {
	parts := strings.SplitN(target, "-", 2)
	start, err := strconv.Atoi(strings.TrimSpace(parts[0]))
	if err != nil || start < 1 {
		return 0, 0, false
	}
	if len(parts) == 1 {
		return start, start, true
	}
	end, err := strconv.Atoi(strings.TrimSpace(parts[1]))
	if err != nil || end < start {
		return 0, 0, false
	}
	return start, end, true
}

func looksLikeDeclaration(line, needle string) bool {
	l := strings.ToLower(strings.TrimSpace(line))
	for _, prefix := range []string{"func ", "def ", "fn ", "class ", "type ", "struct ", "interface ", "const ", "var ", "let ", "export ", "public ", "private ", "static ", "impl ", "package "} {
		if strings.HasPrefix(l, prefix) && strings.Contains(l, needle) {
			return true
		}
	}
	return false
}

// blockEnd finds the closing line of a brace block starting at index start.
func blockEnd(lines []string, start int) int {
	depth := 0
	opened := false
	for i := start; i < len(lines) && i < start+MaxLines; i++ {
		for _, r := range lines[i] {
			switch r {
			case '{':
				depth++
				opened = true
			case '}':
				depth--
				if opened && depth <= 0 {
					return i + 1
				}
			}
		}
		if !opened && i > start && strings.TrimSpace(lines[i]) == "" {
			return i
		}
	}
	return -1
}

func language(path string) string {
	ext := strings.TrimPrefix(strings.ToLower(filepath.Ext(path)), ".")
	switch ext {
	case "go":
		return "go"
	case "ts", "tsx":
		return "ts"
	case "js", "jsx", "mjs", "cjs":
		return "js"
	case "py":
		return "py"
	case "rs":
		return "rust"
	case "json":
		return "json"
	case "md":
		return "md"
	case "sql":
		return "sql"
	case "sh", "bash":
		return "sh"
	case "yml", "yaml":
		return "yaml"
	case "html":
		return "html"
	case "css":
		return "css"
	default:
		return ""
	}
}
