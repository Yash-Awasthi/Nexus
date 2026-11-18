package slice

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const sample = `package demo

func Alpha() {
	println("alpha")
}

func Beta() {
	if true {
		println("beta")
	}
}
`

func writeSample(t *testing.T, name string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte(sample), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestExtractSymbol(t *testing.T) {
	path := writeSample(t, "demo.go")
	out, err := Extract(path, "Beta")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "func Beta") || !strings.Contains(out, "println(\"beta\")") {
		t.Fatalf("slice missed the function:\n%s", out)
	}
	if strings.Contains(out, "func Alpha") {
		t.Fatalf("slice included the wrong function:\n%s", out)
	}
	if !strings.HasPrefix(out, "```go") && !strings.Contains(out, "```go") {
		t.Fatalf("slice should be fenced as go:\n%s", out)
	}
}

func TestExtractLines(t *testing.T) {
	path := writeSample(t, "demo.go")
	out, err := Extract(path, "3-5")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "func Alpha") || strings.Contains(out, "func Beta") {
		t.Fatalf("line slice was wrong:\n%s", out)
	}
	if !strings.Contains(out, ":3-5") {
		t.Fatalf("header should name the range:\n%s", out)
	}

	if _, err := Extract(path, "9999-10000"); err != nil {
		t.Fatalf("out-of-range lines should clamp, not fail: %v", err)
	}
}

func TestExtractErrors(t *testing.T) {
	path := writeSample(t, "demo.go")
	if _, err := Extract(path, "nope-nothing-here"); err == nil {
		t.Fatal("an unmatched symbol should fail")
	}
	if _, err := Extract(filepath.Join(t.TempDir(), "missing.go"), ""); err == nil {
		t.Fatal("a missing file should fail")
	}
	if _, err := Parse("%*%"); err == nil {
		t.Fatal("an empty request should fail")
	}
	req, err := Parse("%*% pkg/db/sqlite.go 10-40")
	if err != nil || req.Path != "pkg/db/sqlite.go" || req.Target != "10-40" {
		t.Fatalf("unexpected parse: %+v %v", req, err)
	}
}
