package connectors

import "sort"

// Preset is a known-good command for a popular local MCP server. Presets only
// fill in the command and arguments; everything else remains editable.
type Preset struct {
	Name        string    `json:"name"`
	Description string    `json:"description"`
	Connector   Connector `json:"connector"`
}

var presets = map[string]Preset{
	"rubrik": {
		Name:        "rubrik",
		Description: "Rubrik Security Cloud through Rubrik's own MCP server (uvx rubrik-mcp). Needs RSC_SERVICE_ACCOUNT_FILE in the environment.",
		Connector:   Connector{Command: "uvx", Args: []string{"rubrik-mcp"}},
	},
	"filesystem": {
		Name:        "filesystem",
		Description: "Reference filesystem MCP server (npx @modelcontextprotocol/server-filesystem <dir>).",
		Connector:   Connector{Command: "npx", Args: []string{"-y", "@modelcontextprotocol/server-filesystem", "."}},
	},
}

// PresetNames lists the presets, sorted.
func PresetNames() []string {
	names := make([]string, 0, len(presets))
	for name := range presets {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// Lookup returns a preset by name.
func Lookup(name string) (Preset, bool) {
	p, ok := presets[name]
	return p, ok
}

// Presets returns every preset, sorted by name.
func Presets() []Preset {
	out := make([]Preset, 0, len(presets))
	for _, name := range PresetNames() {
		out = append(out, presets[name])
	}
	return out
}
