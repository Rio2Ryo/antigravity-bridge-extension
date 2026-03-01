# Antigravity Bridge Extension

VS Code / Antigravity extension that exposes an HTTP bridge server on `localhost:55678`, allowing **OpenClaw agents** to programmatically control the editor via a simple REST API.

## Setup

```bash
# Install dependencies
npm install

# Compile
npm run compile

# Package .vsix
npm run package
```

Install the generated `.vsix` in Antigravity / VS Code:

```
Extensions > ... > Install from VSIX...
```

## Configuration

Add to your `settings.json`:

```jsonc
{
  "antigravityBridge.enabled": true,       // enable/disable server
  "antigravityBridge.port": 55678,         // starting port (auto-increments on conflict)
  "antigravityBridge.host": "127.0.0.1",   // bind address
  "antigravityBridge.authToken": "",        // bearer token for API auth (recommended)
  "antigravityBridge.webhookUrl": "",       // URL to POST file-change events
  "antigravityBridge.logLevel": "info"      // debug | info | warn | error
}
```

## Authentication

When `antigravityBridge.authToken` is set, all API requests (except `GET /api/v1/health`) require a `Bearer` token:

```bash
curl -H "Authorization: Bearer YOUR_TOKEN" ...
```

If the token is empty (default), auth is disabled.

## API

**Endpoint:** `POST http://localhost:55678/api/v1/command`

**Request body:**

```json
{
  "action": "<action>",
  "params": { ... },
  "requestId": "optional-uuid"
}
```

**Response:**

```json
{
  "status": "success" | "error",
  "data": { ... },
  "error": null | "message",
  "requestId": "uuid",
  "timestamp": "ISO-8601"
}
```

### Actions

| Action | Params | Description |
|---|---|---|
| `ping` | — | Health check. Returns `{ message: "pong", uptime }`. |
| `createFile` | `path`, `content` | Create a new file. |
| `readFile` | `path` | Read file contents. Returns `{ path, content }`. |
| `writeFile` | `path`, `content` | Overwrite file contents. |
| `deleteFile` | `path` | Delete a file. |
| `listFiles` | `path` | List directory contents. Returns `{ path, entries: [{ name, type }] }`. |
| `openFile` | `path`, `preview?` | Open file in editor. `preview` defaults to `true`. |
| `executeTerminal` | `command`, `cwd?`, `timeout?` | Run a shell command and capture output. Returns `{ executed, exitCode, stdout, stderr }`. |
| `getWorkspaceFolders` | — | List open workspace folders. |

### Examples

```bash
# Health check
curl -X POST http://localhost:55678/api/v1/command \
  -H 'Content-Type: application/json' \
  -d '{"action":"ping"}'

# Read a file
curl -X POST http://localhost:55678/api/v1/command \
  -H 'Content-Type: application/json' \
  -d '{"action":"readFile","params":{"path":"src/extension.ts"}}'

# Execute terminal command
curl -X POST http://localhost:55678/api/v1/command \
  -H 'Content-Type: application/json' \
  -d '{"action":"executeTerminal","params":{"command":"npm test"}}'
```

### Additional Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/v1/health` | No | Health check. Returns `{ status, version, uptime, sseClients }`. |
| `GET` | `/api/v1/events` | Yes | SSE stream. Emits `connected`, `file-change`, and `task-complete` events. |
| `POST` | `/api/v1/command` | Yes | Execute an action (see Actions table above). |

## SSE Events

Connect to `GET /api/v1/events` to receive real-time events:

```bash
curl -N -H "Authorization: Bearer YOUR_TOKEN" http://localhost:55678/api/v1/events
```

| Event | Description |
|---|---|
| `connected` | Sent on stream open. |
| `file-change` | Workspace file created/changed/deleted. |
| `task-complete` | Emitted after every command dispatch (success or error). |

## File Watcher

When `antigravityBridge.webhookUrl` is set, the extension watches the workspace for file changes and sends `POST` notifications (in addition to SSE events):

```json
{
  "type": "created" | "changed" | "deleted",
  "uri": "/absolute/path/to/file",
  "timestamp": "ISO-8601"
}
```

## Commands

Open the Command Palette (`Ctrl+Shift+P`) and search for:

- **Antigravity Bridge: Start Server**
- **Antigravity Bridge: Stop Server**
- **Antigravity Bridge: Restart Server**
- **Antigravity Bridge: Show Status**

## Logs

View logs in **Output > Antigravity Bridge**.

## License

MIT
