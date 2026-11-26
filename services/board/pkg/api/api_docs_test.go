package api_test

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// The route table lives in `Server.Handler`. This test reads it from the source and compares it
// with `docs/HTTP_API.md`, in both directions: an undocumented route fails (a caller cannot know
// it exists) and a documented route that is gone fails (the page describes something that is not
// there). Both are the same failure — the document and the server disagree.

var routeLine = regexp.MustCompile(`mux\.HandleFunc\("(/api/[^"]*)"`)

func documentedRoutes(t *testing.T) map[string]bool {
	t.Helper()
	page, err := os.ReadFile(filepath.Join("..", "..", "docs", "HTTP_API.md"))
	if err != nil {
		t.Fatal(err)
	}
	// A route appears in the page either in a `| GET | /api/x |` row or in a bare `/api/x` in a
	// curl line. Only the table rows count, so a mention in prose cannot stand in for a row.
	row := regexp.MustCompile("\\|\\s*(?:GET|POST|DELETE|PUT|PATCH)\\s*\\|\\s*`(/api/[^`]+)`")
	found := map[string]bool{}
	for _, match := range row.FindAllStringSubmatch(string(page), -1) {
		found[match[1]] = true
	}
	return found
}

func registeredRoutes(t *testing.T) map[string]bool {
	t.Helper()
	found := map[string]bool{}
	err := filepath.WalkDir(".", func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		source, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		for _, match := range routeLine.FindAllStringSubmatch(string(source), -1) {
			found[match[1]] = true
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return found
}

func TestEveryRouteIsDocumented(t *testing.T) {
	registered := registeredRoutes(t)
	documented := documentedRoutes(t)

	if len(registered) < 20 {
		t.Fatalf("only %d routes found; the pattern probably stopped matching", len(registered))
	}
	for route := range registered {
		if !documented[route] {
			t.Errorf("%s is served but has no row in docs/HTTP_API.md", route)
		}
	}
}

func TestNoDocumentedRouteIsGone(t *testing.T) {
	registered := registeredRoutes(t)
	documented := documentedRoutes(t)
	for route := range documented {
		if !registered[route] {
			t.Errorf("docs/HTTP_API.md documents %s, which is not served", route)
		}
	}
}
