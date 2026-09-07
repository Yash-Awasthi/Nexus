"""
MCP Server Framework Service
Extracted from inspiration repos:
  mcp, modelcontextprotocol, fastmcp, mcp-agent, mcp-proxy,
  mcp-framework, mcp-context-forge, mcp-client-raw-json-rpc-implementation,
  fastify-mcp-server, gopher-mcp, multi-ai-advisor-mcp,
  openapi-mcp, openapi-mcp-codegen, openapi-mcp-codegenerator,
  openapi-mcp-generator, openapi-mcpserver-generator, openapi-to-mcp,
  openapi-to-mcp-converter, openapi-to-mcpserver, openapi-mcpserver-generator,
  mcp-openapi-proxy, decision-protocols, json-rpc-2.0

Provides:
- MCP server scaffolding (tool/resource/prompt registration)
- JSON-RPC 2.0 protocol handling
- OpenAPI → MCP tool conversion
- Transport layer (stdio, SSE, HTTP)
"""

from dataclasses import dataclass, field
from typing import List, Dict, Optional, Any, Callable, Union
from enum import Enum
from datetime import datetime
import json
import asyncio
import inspect
import time
import hashlib


class MCPMessageType(Enum):
    REQUEST = "request"
    RESPONSE = "response"
    NOTIFICATION = "notification"
    ERROR = "error"


class MCPErrorCode(Enum):
    """JSON-RPC 2.0 error codes (extracted from json-rpc-2.0 spec)."""
    PARSE_ERROR = -32700
    INVALID_REQUEST = -32600
    METHOD_NOT_FOUND = -32601
    INVALID_PARAMS = -32602
    INTERNAL_ERROR = -32603
    SERVER_ERROR = -32000


@dataclass
class MCPTool:
    """An MCP tool definition (modelcontextprotocol pattern)."""
    name: str
    description: str
    input_schema: Dict[str, Any]    # JSON Schema for parameters
    handler: Optional[Callable] = None
    annotations: Dict[str, Any] = field(default_factory=dict)


@dataclass
class MCPResource:
    """An MCP resource definition."""
    uri: str
    name: str
    description: str = ""
    mime_type: str = "text/plain"
    handler: Optional[Callable] = None


@dataclass
class MCPPrompt:
    """An MCP prompt template."""
    name: str
    description: str
    arguments: List[Dict[str, Any]] = field(default_factory=list)
    handler: Optional[Callable] = None


@dataclass
class MCPRequest:
    """A JSON-RPC 2.0 request (json-rpc-2.0 pattern)."""
    id: Union[str, int]
    method: str
    params: Dict[str, Any] = field(default_factory=dict)
    jsonrpc: str = "2.0"


@dataclass
class MCPResponse:
    """A JSON-RPC 2.0 response."""
    id: Union[str, int]
    result: Optional[Any] = None
    error: Optional[Dict[str, Any]] = None
    jsonrpc: str = "2.0"

    def to_dict(self) -> Dict:
        d = {"jsonrpc": self.jsonrpc, "id": self.id}
        if self.error:
            d["error"] = self.error
        else:
            d["result"] = self.result
        return d


class MCPServer:
    """
    Model Context Protocol server implementation.
    Extracted from modelcontextprotocol, fastmcp, mcp-framework patterns.

    Supports tool registration, resource serving, prompt templates,
    and the JSON-RPC 2.0 protocol.
    """

    def __init__(self, name: str = "mcp-server", version: str = "1.0.0"):
        self.name = name
        self.version = version
        self.tools: Dict[str, MCPTool] = {}
        self.resources: Dict[str, MCPResource] = {}
        self.prompts: Dict[str, MCPPrompt] = {}
        self._method_handlers: Dict[str, Callable] = {}

        # Register built-in methods
        self._register_builtin_methods()

    def _register_builtin_methods(self):
        self._method_handlers["initialize"] = self._handle_initialize
        self._method_handlers["tools/list"] = self._handle_list_tools
        self._method_handlers["tools/call"] = self._handle_call_tool
        self._method_handlers["resources/list"] = self._handle_list_resources
        self._method_handlers["resources/read"] = self._handle_read_resource
        self._method_handlers["prompts/list"] = self._handle_list_prompts
        self._method_handlers["prompts/get"] = self._handle_get_prompt

    # ---- Tool registration ----

    def tool(self, name: str, description: str, input_schema: Dict[str, Any]):
        """Decorator to register a tool (fastmcp pattern)."""
        def decorator(func: Callable):
            self.register_tool(MCPTool(
                name=name,
                description=description,
                input_schema=input_schema,
                handler=func,
            ))
            return func
        return decorator

    def register_tool(self, tool: MCPTool):
        """Register a tool."""
        self.tools[tool.name] = tool

    def register_resource(self, resource: MCPResource):
        """Register a resource."""
        self.resources[resource.uri] = resource

    def register_prompt(self, prompt: MCPPrompt):
        """Register a prompt template."""
        self.prompts[prompt.name] = prompt

    # ---- JSON-RPC 2.0 protocol handling (json-rpc-2.0 pattern) ----

    async def handle_request(self, raw: str) -> Optional[str]:
        """Handle a raw JSON-RPC request string."""
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            return json.dumps(self._error_response(None, MCPErrorCode.PARSE_ERROR.value, "Parse error"))

        # Handle batch requests
        if isinstance(data, list):
            responses = []
            for item in data:
                resp = await self._handle_single_request(item)
                if resp:
                    responses.append(resp)
            return json.dumps(responses) if responses else None

        return await self._handle_single_request(data)

    async def _handle_single_request(self, data: Dict) -> Optional[Dict]:
        """Handle a single JSON-RPC request."""
        method = data.get("method")
        req_id = data.get("id")
        params = data.get("params", {})

        if not method:
            return self._error_response(req_id, MCPErrorCode.INVALID_REQUEST.value, "Invalid Request")

        handler = self._method_handlers.get(method)
        if not handler:
            return self._error_response(req_id, MCPErrorCode.METHOD_NOT_FOUND.value, f"Method not found: {method}")

        try:
            result = await self._call_handler(handler, params) if asyncio.iscoroutinefunction(handler) else handler(params)
            if req_id is None:
                return None  # Notification — no response
            return {"jsonrpc": "2.0", "id": req_id, "result": result}
        except Exception as e:
            return self._error_response(req_id, MCPErrorCode.INTERNAL_ERROR.value, str(e))

    async def _call_handler(self, handler: Callable, params: Dict):
        return await handler(params)

    def _error_response(self, req_id, code: int, message: str) -> Dict:
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "error": {"code": code, "message": message},
        }

    # ---- Built-in method handlers ----

    def _handle_initialize(self, params: Dict) -> Dict:
        """Handle initialize request (modelcontextprotocol pattern)."""
        return {
            "protocolVersion": "2024-11-05",
            "serverInfo": {
                "name": self.name,
                "version": self.version,
            },
            "capabilities": {
                "tools": {"listChanged": True},
                "resources": {"listChanged": True},
                "prompts": {"listChanged": True},
            },
        }

    def _handle_list_tools(self, params: Dict) -> Dict:
        """List all available tools."""
        return {
            "tools": [
                {
                    "name": t.name,
                    "description": t.description,
                    "inputSchema": t.input_schema,
                    "annotations": t.annotations,
                }
                for t in self.tools.values()
            ]
        }

    async def _handle_call_tool(self, params: Dict) -> Dict:
        """Call a tool by name."""
        tool_name = params.get("name")
        arguments = params.get("arguments", {})

        tool = self.tools.get(tool_name)
        if not tool:
            return {"content": [{"type": "text", "text": f"Tool not found: {tool_name}"}], "isError": True}

        if not tool.handler:
            return {"content": [{"type": "text", "text": "Tool has no handler"}], "isError": True}

        try:
            if asyncio.iscoroutinefunction(tool.handler):
                result = await tool.handler(**arguments)
            else:
                result = tool.handler(**arguments)
            return {
                "content": [{"type": "text", "text": str(result) if not isinstance(result, dict) else json.dumps(result)}],
                "isError": False,
            }
        except Exception as e:
            return {
                "content": [{"type": "text", "text": str(e)}],
                "isError": True,
            }

    def _handle_list_resources(self, params: Dict) -> Dict:
        """List all available resources."""
        return {
            "resources": [
                {
                    "uri": r.uri,
                    "name": r.name,
                    "description": r.description,
                    "mimeType": r.mime_type,
                }
                for r in self.resources.values()
            ]
        }

    def _handle_read_resource(self, params: Dict) -> Dict:
        """Read a resource by URI."""
        uri = params.get("uri")
        resource = self.resources.get(uri)
        if not resource or not resource.handler:
            return {"contents": []}

        content = resource.handler()
        return {
            "contents": [
                {"uri": uri, "mimeType": resource.mime_type, "text": str(content)}
            ]
        }

    def _handle_list_prompts(self, params: Dict) -> Dict:
        """List all available prompts."""
        return {
            "prompts": [
                {
                    "name": p.name,
                    "description": p.description,
                    "arguments": p.arguments,
                }
                for p in self.prompts.values()
            ]
        }

    def _handle_get_prompt(self, params: Dict) -> Dict:
        """Get a rendered prompt."""
        name = params.get("name")
        arguments = params.get("arguments", {})

        prompt = self.prompts.get(name)
        if not prompt:
            return {"messages": []}

        if prompt.handler:
            content = prompt.handler(**arguments) if arguments else prompt.handler()
        else:
            content = prompt.description

        return {
            "messages": [
                {"role": "user", "content": {"type": "text", "text": str(content)}}
            ]
        }


class OpenAPIToMCPConverter:
    """
    Convert OpenAPI specs to MCP tools.
    Extracted from openapi-mcp, openapi-to-mcp, openapi-to-mcp-converter,
    openapi-mcp-codegen, openapi-mcp-generator patterns.
    """

    def convert(self, openapi_spec: Dict[str, Any]) -> List[MCPTool]:
        """Convert an OpenAPI spec to MCP tool definitions."""
        tools = []
        paths = openapi_spec.get("paths", {})

        for path, methods in paths.items():
            for method, spec in methods.items():
                if method.upper() not in ("GET", "POST", "PUT", "PATCH", "DELETE"):
                    continue

                tool_name = self._generate_tool_name(method, path, spec)
                description = spec.get("summary", spec.get("description", f"{method.upper()} {path}"))

                input_schema = self._build_input_schema(path, method, spec)

                tools.append(MCPTool(
                    name=tool_name,
                    description=description,
                    input_schema=input_schema,
                ))

        return tools

    def _generate_tool_name(self, method: str, path: str, spec: Dict) -> str:
        """Generate a tool name from HTTP method and path."""
        operation_id = spec.get("operationId")
        if operation_id:
            return operation_id.replace("-", "_").lower()

        path_parts = path.strip("/").split("/")
        name_parts = [method.lower()]
        for part in path_parts:
            if part.startswith("{"):
                name_parts.append("by_" + part.strip("{}"))
            else:
                name_parts.append(part.replace("-", "_"))
        return "_".join(name_parts)

    def _build_input_schema(self, path: str, method: str, spec: Dict) -> Dict:
        """Build JSON Schema for tool input parameters."""
        properties = {}
        required = []

        # Path parameters
        for param in spec.get("parameters", []):
            if param.get("in") == "path":
                name = param["name"]
                properties[name] = {
                    "type": param.get("schema", {}).get("type", "string"),
                    "description": param.get("description", ""),
                }
                if param.get("required"):
                    required.append(name)
            elif param.get("in") == "query":
                name = param["name"]
                properties[name] = {
                    "type": param.get("schema", {}).get("type", "string"),
                    "description": param.get("description", ""),
                    "default": param.get("schema", {}).get("default"),
                }
                if param.get("required"):
                    required.append(name)

        # Request body
        request_body = spec.get("requestBody")
        if request_body:
            content = request_body.get("content", {})
            json_content = content.get("application/json", {})
            schema = json_content.get("schema", {})
            if schema.get("type") == "object":
                body_props = schema.get("properties", {})
                for prop_name, prop_schema in body_props.items():
                    properties[f"body_{prop_name}"] = prop_schema
                required.extend(
                    [f"body_{p}" for p in schema.get("required", [])]
                )

        return {
            "type": "object",
            "properties": properties,
            "required": required,
        }


# ---- Transport layers (extracted from fastmcp) ----

class MCPTransport:
    """Base transport for MCP communication (fastmcp pattern)."""

    async def send(self, message: str):
        raise NotImplementedError

    async def receive(self) -> Optional[str]:
        raise NotImplementedError

    async def close(self):
        pass


class StdioTransport(MCPTransport):
    """Stdio transport — read from stdin, write to stdout (fastmcp pattern)."""

    async def send(self, message: str):
        import sys
        sys.stdout.write(message + "\n")
        sys.stdout.flush()

    async def receive(self) -> Optional[str]:
        import sys
        line = sys.stdin.readline()
        return line.strip() if line else None


class SSETransport(MCPTransport):
    """Server-Sent Events transport (fastmcp HTTP streaming pattern).

    Maintains an SSE connection for streaming responses.
    """

    def __init__(self):
        self._queue: asyncio.Queue = asyncio.Queue()
        self._closed = False

    async def send(self, message: str):
        await self._queue.put(f"data: {message}\n\n")

    async def receive(self) -> Optional[str]:
        if self._closed:
            return None
        try:
            data = await asyncio.wait_for(self._queue.get(), timeout=30.0)
            # Extract the JSON from SSE data: line
            if data.startswith("data: "):
                return data[6:].strip()
            return data.strip()
        except asyncio.TimeoutError:
            return None

    async def close(self):
        self._closed = True
        await self._queue.put("")  # Unblock any waiting receive


class InMemoryTransport(MCPTransport):
    """In-memory transport for unit testing (fastmcp pattern).

    Two paired transports communicate through a shared queue.
    """

    def __init__(self, pair: Optional["InMemoryTransport"] = None):
        self._queue: asyncio.Queue = asyncio.Queue()
        self._pair = pair or InMemoryTransport(pair=self) if pair is None else pair

    async def send(self, message: str):
        await self._pair._queue.put(message)

    async def receive(self) -> Optional[str]:
        return await self._queue.get()


# ---- Session management (extracted from fastmcp) ----

@dataclass
class MCPSession:
    """An MCP client session (fastmcp session pattern)."""
    session_id: str
    initialized: bool = False
    protocol_version: str = ""
    client_info: Dict[str, Any] = field(default_factory=dict)
    created_at: float = field(default_factory=time.time)
    last_active: float = field(default_factory=time.time)
    roots: List[str] = field(default_factory=list)

    def touch(self):
        self.last_active = time.time()


class SessionManager:
    """Manages MCP client sessions (fastmcp pattern)."""

    def __init__(self, timeout: int = 300):
        self.sessions: Dict[str, MCPSession] = {}
        self.timeout = timeout

    def create_session(self, session_id: Optional[str] = None) -> MCPSession:
        sid = session_id or hashlib.sha256(str(time.time()).encode()).hexdigest()[:16]
        session = MCPSession(session_id=sid)
        self.sessions[sid] = session
        return session

    def get_session(self, session_id: str) -> Optional[MCPSession]:
        session = self.sessions.get(session_id)
        if session:
            session.touch()
        return session

    def close_session(self, session_id: str):
        self.sessions.pop(session_id, None)

    def cleanup_expired(self) -> int:
        """Remove sessions older than timeout. Returns count removed."""
        now = time.time()
        expired = [sid for sid, s in self.sessions.items()
                  if now - s.last_active > self.timeout]
        for sid in expired:
            del self.sessions[sid]
        return len(expired)


# ---- Content types (extracted from fastmcp) ----

@dataclass
class ImageContent:
    """Image content block for tool results (fastmcp pattern)."""
    data: str       # Base64-encoded image data
    mime_type: str = "image/png"

    def to_dict(self) -> Dict:
        return {"type": "image", "data": self.data, "mimeType": self.mime_type}


@dataclass
class AudioContent:
    """Audio content block for tool results (fastmcp pattern)."""
    data: str       # Base64-encoded audio data
    mime_type: str = "audio/wav"

    def to_dict(self) -> Dict:
        return {"type": "audio", "data": self.data, "mimeType": self.mime_type}


def image_content(base64_data: str, mime_type: str = "image/png") -> Dict:
    """Create an image content block (fastmcp helper)."""
    return ImageContent(data=base64_data, mime_type=mime_type).to_dict()


def audio_content(base64_data: str, mime_type: str = "audio/wav") -> Dict:
    """Create an audio content block (fastmcp helper)."""
    return AudioContent(data=base64_data, mime_type=mime_type).to_dict()


# ---- Progress notifications (extracted from fastmcp) ----

@dataclass
class ProgressNotification:
    """Progress notification for long-running operations (fastmcp pattern)."""
    progress_token: str
    progress: float         # 0-1 or absolute value
    total: Optional[float] = None
    message: str = ""

    def to_notification(self) -> Dict:
        return {
            "jsonrpc": "2.0",
            "method": "notifications/progress",
            "params": {
                "progressToken": self.progress_token,
                "progress": self.progress,
                "total": self.total,
                "message": self.message,
            },
        }
