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
  "antigravityBridge.webhookUrl": "",       // URL to POST file-change events
  "antigravityBridge.logLevel": "info"      // debug | info | warn | error
}
```

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
| `openFile` | `path`, `preview?` | Open file in editor. `preview` defaults to `true`. |
| `executeTerminal` | `command`, `cwd?` | Run a shell command in an integrated terminal. |
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

## File Watcher

When `antigravityBridge.webhookUrl` is set, the extension watches the workspace for file changes and sends `POST` notifications:

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
