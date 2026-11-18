package wake

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"open-board/pkg/agents"
)

func TestLoadMissingFileIsNoRules(t *testing.T) {
	cfg, err := Load(filepath.Join(t.TempDir(), "wake.json"))
	if err != nil {
		t.Fatalf("a missing wake config is not an error: %v", err)
	}
	if len(cfg.Agents) != 0 {
		t.Fatalf("unexpected rules: %v", cfg.Agents)
	}
	if NewLauncher(cfg, nil, t.TempDir()).Enabled() {
		t.Fatal("an empty config must not enable wake")
	}
}

func TestLoadParsesRulesAndNormalizesNames(t *testing.T) {
	path := filepath.Join(t.TempDir(), "wake.json")
	body := `{"agents":{"Claude":{"manifest":"claude","args":["-p","{message}"]}}}`
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"claude", "@claude", "CLAUDE"} {
		if _, ok := cfg.Rule(name); !ok {
			t.Fatalf("%q should match the rule", name)
		}
	}
	if _, ok := cfg.Rule("cline"); ok {
		t.Fatal("an unlisted agent has no rule")
	}
}

func TestSubstitute(t *testing.T) {
	vars := map[string]string{"agent": "claude", "channel": "demo", "thread": "sprint-1", "message": "hello"}
	got := substitute("check {channel}/{thread} as {agent}: {message}", vars)
	if got != "check demo/sprint-1 as claude: hello" {
		t.Fatalf("got %q", got)
	}
	if oneLine("a\nb\r\nc", 100) != "a b c" {
		t.Fatalf("oneLine should flatten newlines: %q", oneLine("a\nb\r\nc", 100))
	}
	if len(oneLine(strings.Repeat("x", 50), 10)) != 10 {
		t.Fatal("oneLine should cap its length")
	}
}

func TestWakeLaunchesOncePerCooldown(t *testing.T) {
	t.Setenv("VB_WAKE_HELPER", "1")
	dir := t.TempDir()
	cfg := &Config{Agents: map[string]Agent{
		"helper": {Command: os.Args[0], Args: []string{"-test.run=TestWakeHelper"}, CooldownSeconds: 60},
	}}
	launcher := NewLauncher(cfg, nil, dir)
	clock := time.Date(2026, 11, 21, 10, 0, 0, 0, time.UTC)
	launcher.clock = func() time.Time { return clock }

	started, err := launcher.Wake("helper", "demo", "sprint-1", "check your inbox")
	if err != nil {
		t.Fatalf("wake: %v", err)
	}
	if !started {
		t.Fatal("the helper should have been launched")
	}

	logPath := filepath.Join(dir, "demo", "agents", "helper-wake.log")
	deadline := time.Now().Add(5 * time.Second)
	for {
		data, err := os.ReadFile(logPath)
		if err == nil && strings.Contains(string(data), "wake-helper-ran") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the launched process did not write to its log: %v %q", err, data)
		}
		time.Sleep(20 * time.Millisecond)
	}

	started, err = launcher.Wake("helper", "demo", "sprint-1", "again")
	if err != nil || started {
		t.Fatalf("a second wake inside the cooldown must be skipped: started=%t err=%v", started, err)
	}

	clock = clock.Add(2 * time.Minute)
	if started, err = launcher.Wake("helper", "demo", "sprint-1", "after cooldown"); err != nil || !started {
		t.Fatalf("after the cooldown a wake should run: started=%t err=%v", started, err)
	}
}

func TestWakeRefusesUnknownAndBrokenRules(t *testing.T) {
	cfg := &Config{Agents: map[string]Agent{
		"broken": {},
		"ghost":  {Manifest: "not-a-manifest"},
	}}
	l := NewLauncher(cfg, nil, t.TempDir())
	if started, err := l.Wake("nobody", "demo", "s", ""); err != nil || started {
		t.Fatalf("an unlisted agent is not launched: %t %v", started, err)
	}
	if _, err := l.Wake("broken", "demo", "s", ""); err == nil {
		t.Fatal("a rule without a command or manifest should fail")
	}
	if _, err := l.Wake("ghost", "demo", "s", ""); err == nil {
		t.Fatal("an unknown manifest should fail")
	}
}

func TestWakeUsesSupervisorForManifestRules(t *testing.T) {
	t.Setenv("VB_WAKE_HELPER", "1")
	dir := t.TempDir()
	manifestDir := filepath.Join(dir, "manifests")
	if err := os.MkdirAll(manifestDir, 0o755); err != nil {
		t.Fatal(err)
	}
	manifest := agents.Manifest{
		ID:   "helper",
		Name: "Wake Helper",
		Bin:  os.Args[0],
		Args: []string{"-test.run=TestWakeHelper"},
	}
	data, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(manifestDir, "helper.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}
	reg, _, err := agents.LoadRegistry(manifestDir)
	if err != nil {
		t.Fatal(err)
	}
	sup := agents.NewSupervisor(reg, dir)
	cfg := &Config{Agents: map[string]Agent{"helper": {Manifest: "helper"}}}
	launcher := NewLauncher(cfg, reg, dir)
	launcher.Supervisor = sup

	started, err := launcher.Wake("helper", "demo", "sprint-1", "@helper check the inbox")
	if err != nil {
		t.Fatalf("wake: %v", err)
	}
	if !started {
		t.Fatal("the manifest rule should start a supervised agent")
	}

	logPath := filepath.Join(dir, "demo", "agents", "helper-supervisor.log")
	deadline := time.Now().Add(5 * time.Second)
	for {
		data, err := os.ReadFile(logPath)
		if err == nil && strings.Contains(string(data), "wake-helper-ran") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("supervised wake did not write to its log: %v %q", err, data)
		}
		time.Sleep(20 * time.Millisecond)
	}

	deadline = time.Now().Add(5 * time.Second)
	for sup.Running("helper") {
		if time.Now().After(deadline) {
			t.Fatal("supervised helper did not exit")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// TestWakeHelper is the process Wake starts; it only runs when invoked by the
// launcher, which sets VB_WAKE_HELPER.
func TestWakeHelper(t *testing.T) {
	if os.Getenv("VB_WAKE_HELPER") != "1" {
		t.Skip("helper process only")
	}
	fmt.Println("wake-helper-ran")
}
