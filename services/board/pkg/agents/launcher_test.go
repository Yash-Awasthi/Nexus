package agents_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"open-board/pkg/agents"
)

func TestEmbeddedManifestsLoadWithoutSources(t *testing.T) {
	reg, used, err := agents.LoadRegistry(filepath.Join(t.TempDir(), "does-not-exist"))
	if err != nil {
		t.Fatalf("embedded manifests should load on their own: %v", err)
	}
	if len(used) != 0 {
		t.Fatalf("no manifest directory exists, yet %v was used", used)
	}
	list := reg.List()
	if len(list) < 5 {
		t.Fatalf("expected the embedded manifest set, got %d", len(list))
	}
	for _, id := range []string{"claude", "antigravity", "cline", "aider"} {
		if _, ok := reg.Get(id); !ok {
			t.Fatalf("embedded manifests are missing %q", id)
		}
	}
}

func TestManifestDirectoryOverridesEmbedded(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "manifests")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	override := `{"id":"claude","name":"Claude Override","adapter":"terminal","bin":"claude"}`
	if err := os.WriteFile(filepath.Join(dir, "claude.json"), []byte(override), 0o644); err != nil {
		t.Fatal(err)
	}

	reg, used, err := agents.LoadRegistry(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(used) != 1 || used[0] != dir {
		t.Fatalf("unexpected used dirs: %v", used)
	}
	m, ok := reg.Get("claude")
	if !ok || m.Name != "Claude Override" {
		t.Fatalf("the directory should override the embedded manifest, got %+v", m)
	}
	if _, ok := reg.Get("antigravity"); !ok {
		t.Fatal("overriding one manifest should not drop the others")
	}
}

func TestResolveExecutable(t *testing.T) {
	reg, _, err := agents.LoadRegistry()
	if err != nil {
		t.Fatal(err)
	}

	own := agents.Manifest{ID: "self", Name: "Self", Bin: os.Args[0]}
	path, err := reg.ResolveExecutable(own)
	if err != nil || path == "" {
		t.Fatalf("an absolute binary should resolve: %q %v", path, err)
	}

	missing := agents.Manifest{ID: "missing", Name: "Missing Agent", Bin: "definitely-not-a-real-agent-binary"}
	if _, err := reg.ResolveExecutable(missing); err == nil || !strings.Contains(err.Error(), "not installed") {
		t.Fatalf("a missing binary should explain itself, got %v", err)
	}
}
