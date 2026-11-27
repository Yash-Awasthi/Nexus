package api

import (
	"fmt"
	"net/http"
	"strings"

	"open-board/pkg/connectors"
)

// connectorsHandler lists, adds and removes configured connectors.
func (s *Server) handleConnectors(w http.ResponseWriter, r *http.Request) {
	if s.Connectors == nil {
		writeErr(w, http.StatusServiceUnavailable, "connectors are not available in this broker")
		return
	}
	switch r.Method {
	case http.MethodGet:
		out := map[string]any{
			"connectors": s.Connectors.List(),
			"path":       s.Connectors.Path(),
			"presets":    connectors.Presets(),
		}
		writeJSON(w, http.StatusOK, out)
	case http.MethodPost:
		var req struct {
			Name    string            `json:"name"`
			Command string            `json:"command"`
			Args    []string          `json:"args"`
			Env     map[string]string `json:"env"`
			Deny    []string          `json:"deny"`
			Preset  string            `json:"preset"`
		}
		if !decodeBody(w, r, &req) {
			return
		}
		conn := connectors.Connector{Command: strings.TrimSpace(req.Command), Args: req.Args, Env: req.Env, Deny: req.Deny}
		if req.Preset != "" {
			preset, ok := connectors.Lookup(req.Preset)
			if !ok {
				writeErr(w, http.StatusBadRequest, "unknown preset: "+req.Preset)
				return
			}
			conn.Command, conn.Args = preset.Connector.Command, preset.Connector.Args
			if req.Name == "" {
				req.Name = preset.Name
			}
		}
		if strings.TrimSpace(req.Name) == "" {
			writeErr(w, http.StatusBadRequest, "connector name is required")
			return
		}
		if err := s.Connectors.Add(req.Name, conn); err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		if s.Log != nil {
			s.Log.Printf("connector %s added (%s)", req.Name, conn.Command)
		}
		writeJSON(w, http.StatusCreated, map[string]any{"connector": req.Name})
	case http.MethodDelete:
		name := r.URL.Query().Get("name")
		if name == "" {
			writeErr(w, http.StatusBadRequest, "name is required")
			return
		}
		if err := s.Connectors.Remove(name); err != nil {
			writeErr(w, http.StatusNotFound, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"removed": name})
	default:
		requireMethod(w, r, http.MethodGet, http.MethodPost, http.MethodDelete)
	}
}

// handleConnectorTools returns the tools one connector advertises.
func (s *Server) handleConnectorTools(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	if s.Connectors == nil {
		writeErr(w, http.StatusServiceUnavailable, "connectors are not available in this broker")
		return
	}
	name := r.URL.Query().Get("name")
	if name == "" {
		writeErr(w, http.StatusBadRequest, "name is required")
		return
	}
	tools, err := s.Connectors.Tools(r.Context(), name)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	if tools == nil {
		tools = []connectors.Tool{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"connector": name, "tools": tools})
}

type connectorCallRequest struct {
	Channel   string         `json:"channel"`
	Thread    string         `json:"thread"`
	Connector string         `json:"connector"`
	Tool      string         `json:"tool"`
	Arguments map[string]any `json:"arguments"`
	Note      *bool          `json:"note"`
}

// handleConnectorCall runs one tool and optionally notes it on a thread.
func (s *Server) handleConnectorCall(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	if s.Connectors == nil {
		writeErr(w, http.StatusServiceUnavailable, "connectors are not available in this broker")
		return
	}
	var req connectorCallRequest
	if !decodeBody(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Connector) == "" || strings.TrimSpace(req.Tool) == "" {
		writeErr(w, http.StatusBadRequest, "connector and tool are required")
		return
	}
	result, err := s.Connectors.Call(r.Context(), req.Connector, req.Tool, req.Arguments)
	if err != nil {
		if s.Log != nil {
			s.Log.Printf("connector %s/%s failed: %v", req.Connector, req.Tool, err)
		}
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	if len(result.Text) > 256<<10 {
		result.Text = result.Text[:256<<10] + "\n… (truncated)"
	}

	var event any
	note := req.Note == nil || *req.Note
	if note && strings.TrimSpace(req.Thread) != "" {
		channel := req.Channel
		if channel == "" {
			channel = s.Channel
		}
		if d, err := s.Store.Get(channel); err == nil {
			content := fmt.Sprintf("connector: %s/%s ok in %dms", req.Connector, req.Tool, result.DurationMS)
			if ev, err := d.AppendEvent(channel, req.Thread, "connector", "note", content, nil, ""); err == nil {
				s.Broadcast(envelope{Channel: channel, Type: "message.posted", Event: ev})
				event = ev
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"result": result, "event": event})
}

// handleConnectorPresets lists the built-in presets.
func (s *Server) handleConnectorPresets(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodGet) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"presets": connectors.Presets()})
}
