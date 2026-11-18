// Package agents loads PocketDesk-style manifests to discover local coding
// agents and launch them.
package agents

import (
	"embed"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

// embeddedManifests ships a manifest for every supported agent, so discovery
// works from any working directory with no sources/ checkout.
//
//go:embed manifests/*.json
var embeddedManifests embed.FS

// ManifestPlatform overrides a manifest's binary on one platform.
type ManifestPlatform struct {
	Bin     string   `json:"bin"`
	Args    []string `json:"args"`
	Adapter string   `json:"adapter"`
}

// Manifest describes one local agent.
type Manifest struct {
	ID        string                      `json:"id"`
	Name      string                      `json:"name"`
	Adapter   string                      `json:"adapter"`
	Bin       string                      `json:"bin"`
	Args      []string                    `json:"args"`
	Paths     map[string]string           `json:"paths"`
	Platforms map[string]ManifestPlatform `json:"platforms"`
	Chat      ManifestChat                `json:"chat"`
	Docs      string                      `json:"docs"`
}

// ManifestChat is how a manifest runs one headless turn with a prompt.
type ManifestChat struct {
	Args       []string `json:"args"`
	ResumeArgs []string `json:"resumeArgs"`
}

// Discovered pairs a manifest with what the machine actually has.
type Discovered struct {
	Manifest
	Executable string `json:"executable,omitempty"`
	Problem    string `json:"problem,omitempty"`
	Dir        string `json:"dir,omitempty"`
}

// Registry is the manifests found on disk.
type Registry struct {
	manifests map[string]Manifest
}

// DefaultDirs returns the manifest directories to look in, in order.
func DefaultDirs() []string {
	var dirs []string
	if env := os.Getenv("VB_MANIFESTS"); env != "" {
		for _, d := range filepath.SplitList(env) {
			dirs = append(dirs, d)
		}
	}
	if exe, err := os.Executable(); err == nil {
		dirs = append(dirs, filepath.Join(filepath.Dir(exe), "manifests"))
	}
	dirs = append(dirs, filepath.Join("sources", "pocketdesk", "manifests"), "manifests")
	return dirs
}

// LoadRegistry reads the embedded manifests, then every manifest it can from
// the given directories, which may override an embedded one by id.
func LoadRegistry(dirs ...string) (*Registry, []string, error) {
	reg := &Registry{manifests: map[string]Manifest{}}
	var used []string
	if err := reg.loadEmbedded(); err != nil {
		return reg, used, err
	}
	seen := map[string]bool{}
	for _, dir := range dirs {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		found := false
		for _, entry := range entries {
			if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
				continue
			}
			data, err := os.ReadFile(filepath.Join(dir, entry.Name()))
			if err != nil {
				continue
			}
			var m Manifest
			if err := json.Unmarshal(data, &m); err != nil || m.ID == "" {
				continue
			}
			m = applyPlatform(m)
			if seen[m.ID] {
				continue // an earlier directory already overrode this manifest
			}
			seen[m.ID] = true
			reg.manifests[m.ID] = m
			found = true
		}
		if found {
			used = append(used, dir)
		}
	}
	if len(reg.manifests) == 0 {
		return reg, used, fmt.Errorf("no agent manifests found (looked in %s)", strings.Join(dirs, ", "))
	}
	return reg, used, nil
}

// loadEmbedded parses the manifests built into the binary.
func (r *Registry) loadEmbedded() error {
	entries, err := embeddedManifests.ReadDir("manifests")
	if err != nil {
		return fmt.Errorf("read embedded manifests: %w", err)
	}
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		data, err := embeddedManifests.ReadFile("manifests/" + entry.Name())
		if err != nil {
			continue
		}
		var m Manifest
		if err := json.Unmarshal(data, &m); err != nil || m.ID == "" {
			continue
		}
		r.manifests[m.ID] = applyPlatform(m)
	}
	return nil
}

func platformKeys() []string {
	switch runtime.GOOS {
	case "windows":
		return []string{"win32", "windows"}
	case "darwin":
		return []string{"darwin", "macos"}
	case "linux":
		return []string{"linux"}
	default:
		return []string{runtime.GOOS}
	}
}

func applyPlatform(m Manifest) Manifest {
	for _, key := range platformKeys() {
		if p, ok := m.Platforms[key]; ok {
			if p.Bin != "" {
				m.Bin = p.Bin
			}
			if len(p.Args) > 0 {
				m.Args = p.Args
			}
			if p.Adapter != "" {
				m.Adapter = p.Adapter
			}
			break
		}
	}
	return m
}

// Get returns one manifest.
func (r *Registry) Get(id string) (Manifest, bool) {
	m, ok := r.manifests[id]
	return m, ok
}

// List returns every manifest sorted by name.
func (r *Registry) List() []Manifest {
	list := make([]Manifest, 0, len(r.manifests))
	for _, m := range r.manifests {
		list = append(list, m)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].ID < list[j].ID })
	return list
}

// ResolveExecutable finds the binary a manifest names.
func (r *Registry) ResolveExecutable(m Manifest) (string, error) {
	if m.Bin != "" {
		if path, err := exec.LookPath(m.Bin); err == nil {
			return path, nil
		}
		if filepath.IsAbs(m.Bin) {
			if _, err := os.Stat(m.Bin); err == nil {
				return m.Bin, nil
			}
		}
	}
	for _, key := range platformKeys() {
		raw, ok := m.Paths[key]
		if !ok {
			continue
		}
		expanded := os.ExpandEnv(raw)
		if _, err := os.Stat(expanded); err == nil {
			return expanded, nil
		}
	}
	if m.Bin != "" {
		return "", fmt.Errorf("%s is not installed (looked for %q on PATH and in its manifest paths)", m.Name, m.Bin)
	}
	return "", fmt.Errorf("%s is not installed on %s", m.Name, runtime.GOOS)
}

// Discover resolves every manifest on this machine.
func (r *Registry) Discover() []Discovered {
	out := make([]Discovered, 0, len(r.manifests))
	for _, m := range r.List() {
		d := Discovered{Manifest: m}
		if exe, err := r.ResolveExecutable(m); err != nil {
			d.Problem = err.Error()
		} else {
			d.Executable = exe
		}
		out = append(out, d)
	}
	return out
}

// Launch starts an agent detached, with its output in logPath. It returns the
// started command so the caller can report the pid.
func Launch(m Manifest, args []string, logPath string) (*exec.Cmd, error) {
	reg := &Registry{manifests: map[string]Manifest{m.ID: m}}
	exe, err := reg.ResolveExecutable(m)
	if err != nil {
		return nil, err
	}
	if len(args) == 0 {
		args = m.Args
	}
	if err := os.MkdirAll(filepath.Dir(logPath), 0o755); err != nil {
		return nil, err
	}
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return nil, err
	}
	fmt.Fprintf(logFile, "\n--- %s launch %s ---\n", time.Now().Format(time.RFC3339), m.ID)

	cmd := exec.Command(exe, args...)
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	if err := cmd.Start(); err != nil {
		logFile.Close()
		return nil, err
	}
	go func() {
		_ = cmd.Wait()
		logFile.Close()
	}()
	return cmd, nil
}
