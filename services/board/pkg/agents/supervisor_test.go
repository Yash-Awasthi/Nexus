package agents_test

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

func helperRegistry(t *testing.T, args ...string) *agents.Registry {
	t.Helper()
	dir := t.TempDir()
	manifest := agents.Manifest{
		ID:   "helper",
		Name: "Supervisor Helper",
		Bin:  os.Args[0],
		Args: append([]string{"-test.run=TestSupervisorHelper", "--", "--supervisor-helper"}, args...),
	}
	data, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "helper.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}
	reg, _, err := agents.LoadRegistry(dir)
	if err != nil {
		t.Fatal(err)
	}
	return reg
}

func TestSupervisorCapturesOutputAndSuccess(t *testing.T) {
	reg := helperRegistry(t, "0")
	sup := agents.NewSupervisor(reg, t.TempDir())

	p, err := sup.Start("helper", nil, "demo", "sprint-1", "@helper please run")
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	if p.PID <= 0 || !sup.Running("helper") {
		t.Fatalf("process should be running: pid=%d", p.PID)
	}

	select {
	case <-p.Done():
	case <-time.After(10 * time.Second):
		t.Fatal("helper did not exit")
	}
	code, err := p.Wait()
	if code != 0 || err != nil {
		t.Fatalf("want clean exit, got code=%d err=%v", code, err)
	}
	if sup.Running("helper") {
		t.Fatal("a finished process must not be reported running")
	}

	data, err := os.ReadFile(p.LogPath)
	if err != nil {
		t.Fatal(err)
	}
	log := string(data)
	if !strings.Contains(log, "supervisor-helper-output") {
		t.Fatalf("stdout was not captured: %q", log)
	}
	if !strings.Contains(log, "exit code 0") || !strings.Contains(log, "@helper please run") {
		t.Fatalf("log is missing the exit or mention header: %q", log)
	}
}

func TestSupervisorReportsNonZeroExits(t *testing.T) {
	reg := helperRegistry(t, "7")
	sup := agents.NewSupervisor(reg, t.TempDir())
	failed := make(chan agents.Exit, 1)
	sup.OnFailure = func(e agents.Exit) { failed <- e }

	p, err := sup.Start("helper", nil, "demo", "s", "")
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	select {
	case e := <-failed:
		if e.Agent != "helper" || e.Code != 7 || e.PID != p.PID {
			t.Fatalf("unexpected failure: %+v", e)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("non-zero exit was not reported")
	}
	if code, _ := p.Wait(); code != 7 {
		t.Fatalf("want exit code 7, got %d", code)
	}
}

func TestSupervisorCoalescesA_RunningAgent(t *testing.T) {
	reg := helperRegistry(t, "sleep", "300")
	sup := agents.NewSupervisor(reg, t.TempDir())
	p, err := sup.Start("helper", nil, "demo", "s", "")
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	again, err := sup.Start("helper", nil, "demo", "s", "")
	if err != nil {
		t.Fatalf("second start: %v", err)
	}
	if again != p {
		t.Fatal("a running agent should not be started twice")
	}
	if len(sup.Processes()) != 1 {
		t.Fatalf("want one tracked process, got %d", len(sup.Processes()))
	}
	select {
	case <-p.Done():
	case <-time.After(10 * time.Second):
		t.Fatal("sleeping helper did not exit")
	}
}

func TestSupervisorUnknownManifest(t *testing.T) {
	reg := helperRegistry(t, "0")
	sup := agents.NewSupervisor(reg, t.TempDir())
	if _, err := sup.Start("not-a-manifest", nil, "demo", "s", ""); err == nil {
		t.Fatal("an unknown manifest should fail")
	}
}

func TestSupervisorStartTaskPassesPromptAndTaskID(t *testing.T) {
	reg := helperRegistry(t, "0")
	sup := agents.NewSupervisor(reg, t.TempDir())
	prompt := "task-prompt: implement the parser contract"

	p, err := sup.StartTask("helper", "s.T1", nil, "demo", "s", prompt)
	if err != nil {
		t.Fatalf("start task: %v", err)
	}
	if p.TaskID != "s.T1" {
		t.Fatalf("process did not record its task: %q", p.TaskID)
	}
	select {
	case <-p.Done():
	case <-time.After(10 * time.Second):
		t.Fatal("helper did not exit")
	}
	data, err := os.ReadFile(p.LogPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), prompt) {
		t.Fatalf("the task prompt was not passed to the agent: %q", data)
	}
	if p.LogPath != sup.LogPath("demo", "@helper") {
		t.Fatalf("LogPath must name the file the supervisor writes: %q vs %q", p.LogPath, sup.LogPath("demo", "helper"))
	}
}

func TestSupervisorRefusesASecondTaskForARunningAgent(t *testing.T) {
	reg := helperRegistry(t, "sleep", "300")
	sup := agents.NewSupervisor(reg, t.TempDir())
	first, err := sup.StartTask("helper", "s.T1", nil, "demo", "s", "first")
	if err != nil {
		t.Fatalf("first start: %v", err)
	}
	if _, err := sup.StartTask("helper", "s.T2", nil, "demo", "s", "second"); err == nil {
		t.Fatal("a running agent must not silently take a second task")
	}
	if again, err := sup.StartTask("helper", "s.T1", nil, "demo", "s", "first"); err != nil || again != first {
		t.Fatalf("the same task should coalesce: %v %v", again, err)
	}
	<-first.Done()
}

func TestSupervisorTerminateStopsARunningAgent(t *testing.T) {
	reg := helperRegistry(t, "sleep", "30000")
	sup := agents.NewSupervisor(reg, t.TempDir())
	p, err := sup.Start("helper", nil, "demo", "s", "")
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	pid, err := sup.Terminate("@helper")
	if err != nil {
		t.Fatalf("terminate: %v", err)
	}
	if pid != p.PID {
		t.Fatalf("terminated the wrong pid: %d vs %d", pid, p.PID)
	}
	select {
	case <-p.Done():
	case <-time.After(10 * time.Second):
		t.Fatal("a terminated agent must exit")
	}
	if sup.Running("helper") {
		t.Fatal("terminated agent still reported running")
	}
	if _, err := sup.Terminate("helper"); err == nil {
		t.Fatal("terminating a stopped agent should fail cleanly")
	}
}

// TestSupervisorHelper is the subprocess the supervisor launches. It exits
// immediately unless the supervisor-specific argument is present.
func TestSupervisorHelper(t *testing.T) {
	for i, arg := range os.Args {
		if arg != "--supervisor-helper" {
			continue
		}
		if i+1 >= len(os.Args) {
			fmt.Println("helper: missing mode")
			os.Exit(2)
		}
		mode := os.Args[i+1]
		if mode == "sleep" {
			delay := 0
			if i+2 < len(os.Args) {
				fmt.Sscanf(os.Args[i+2], "%d", &delay)
			}
			fmt.Println("supervisor-helper-sleeping")
			time.Sleep(time.Duration(delay) * time.Millisecond)
			os.Exit(0)
		}
		code := 0
		fmt.Sscanf(mode, "%d", &code)
		fmt.Println("supervisor-helper-output")
		fmt.Println("helper-args:", strings.Join(os.Args[i:], " "))
		os.Exit(code)
	}
}
