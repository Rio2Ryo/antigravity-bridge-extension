/**
 * E2E tests for the Antigravity Bridge HTTP server.
 *
 * These tests spin up a real HTTP server (bypassing the VS Code extension
 * host) and verify the command dispatch + JSON protocol. File operations
 * use the real filesystem via a temp directory.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as http from 'http';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ---------------------------------------------------------------------------
// Minimal server that mirrors BridgeServer's dispatch logic but calls
// real filesystem operations (no vscode dependency).
// ---------------------------------------------------------------------------

interface CommandRequest {
  action: string;
  params?: Record<string, unknown>;
  requestId?: string;
}

interface CommandResponse {
  status: 'success' | 'error';
  data: unknown;
  error: string | null;
  requestId: string;
  timestamp: string;
}

const TEST_AUTH_TOKEN = 'test-secret-token-123';

let server: http.Server;
let port: number;
let tmpDir: string;

function makeResponse(
  status: 'success' | 'error',
  data: unknown,
  error: string | null,
  requestId?: string,
): CommandResponse {
  return {
    status,
    data,
    error,
    requestId: requestId ?? crypto.randomUUID(),
    timestamp: new Date().toISOString(),
  };
}

async function handleAction(action: string, params: Record<string, unknown>): Promise<unknown> {
  switch (action) {
    case 'ping':
      return { message: 'pong', uptime: process.uptime() };

    case 'createFile': {
      const filePath = String(params.path ?? '');
      const content = String(params.content ?? '');
      if (!filePath) throw new Error('Missing required parameter: path');
      const resolved = path.isAbsolute(filePath) ? filePath : path.join(tmpDir, filePath);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, content, 'utf-8');
      return { path: resolved };
    }

    case 'readFile': {
      const filePath = String(params.path ?? '');
      if (!filePath) throw new Error('Missing required parameter: path');
      const resolved = path.isAbsolute(filePath) ? filePath : path.join(tmpDir, filePath);
      const content = fs.readFileSync(resolved, 'utf-8');
      return { path: resolved, content };
    }

    case 'writeFile': {
      const filePath = String(params.path ?? '');
      const content = String(params.content ?? '');
      if (!filePath) throw new Error('Missing required parameter: path');
      const resolved = path.isAbsolute(filePath) ? filePath : path.join(tmpDir, filePath);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, content, 'utf-8');
      return { path: resolved };
    }

    case 'deleteFile': {
      const filePath = String(params.path ?? '');
      if (!filePath) throw new Error('Missing required parameter: path');
      const resolved = path.isAbsolute(filePath) ? filePath : path.join(tmpDir, filePath);
      fs.unlinkSync(resolved);
      return { path: resolved };
    }

    case 'listFiles': {
      const dirPath = String(params.path ?? '');
      if (!dirPath) throw new Error('Missing required parameter: path');
      const resolved = path.isAbsolute(dirPath) ? dirPath : path.join(tmpDir, dirPath);
      const items = fs.readdirSync(resolved, { withFileTypes: true });
      const entries = items.map(item => ({
        name: item.name,
        type: item.isDirectory() ? 'directory' : 'file',
      }));
      return { path: resolved, entries };
    }

    case 'executeTerminal': {
      const command = String(params.command ?? '');
      if (!command) throw new Error('Missing required parameter: command');
      const { execSync } = await import('child_process');
      try {
        const stdout = execSync(command, { cwd: tmpDir, timeout: 10_000, encoding: 'utf-8' });
        return { executed: true, exitCode: 0, stdout, stderr: '' };
      } catch (err: unknown) {
        const e = err as { status?: number; stdout?: string; stderr?: string };
        return { executed: true, exitCode: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
      }
    }

    case 'getDiagnostics': {
      const filePath = params.path ? String(params.path) : undefined;
      const severityFilter = params.severity ? String(params.severity) : undefined;
      const diagnostics: Array<{
        file: string;
        range: { startLine: number; startColumn: number; endLine: number; endColumn: number };
        message: string;
        severity: string;
        source: string;
        code: string;
      }> = [];

      function scanFileForDiags(fullPath: string) {
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const marker = line.match(/\/\/\s*@(error|warning|information|hint)\s+(.*)/i);
            if (marker) {
              diagnostics.push({
                file: fullPath,
                range: { startLine: i + 1, startColumn: 0, endLine: i + 1, endColumn: line.length },
                message: marker[2].trim(),
                severity: marker[1].toLowerCase(),
                source: 'test-linter',
                code: '',
              });
            }
          }
        } catch { /* skip */ }
      }

      function walkForDiags(dir: string) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) { walkForDiags(full); }
          else if (entry.isFile()) { scanFileForDiags(full); }
        }
      }

      if (filePath) {
        const resolved = path.isAbsolute(filePath) ? filePath : path.join(tmpDir, filePath);
        scanFileForDiags(resolved);
      } else {
        walkForDiags(tmpDir);
      }

      const filtered = severityFilter
        ? diagnostics.filter(d => d.severity === severityFilter)
        : diagnostics;

      return {
        diagnostics: filtered,
        totalCount: filtered.length,
        errorCount: filtered.filter(d => d.severity === 'error').length,
        warningCount: filtered.filter(d => d.severity === 'warning').length,
        informationCount: filtered.filter(d => d.severity === 'information').length,
        hintCount: filtered.filter(d => d.severity === 'hint').length,
      };
    }

    case 'searchInFiles': {
      const query = String(params.query ?? '');
      if (!query) throw new Error('Missing required parameter: query');
      const searchPath = params.path ? String(params.path) : tmpDir;
      const resolved = path.isAbsolute(searchPath) ? searchPath : path.join(tmpDir, searchPath);
      const maxResults = typeof params.maxResults === 'number' ? params.maxResults : 100;
      const isRegex = params.regex === true;
      const caseSensitive = params.caseSensitive !== false;
      const matches: Array<{ file: string; line: number; column: number; text: string }> = [];

      function walk(dir: string) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (matches.length >= maxResults) return;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '.git') continue;
            walk(full);
          } else if (entry.isFile()) {
            try {
              const content = fs.readFileSync(full, 'utf-8');
              const lines = content.split('\n');
              for (let i = 0; i < lines.length; i++) {
                if (matches.length >= maxResults) return;
                const lineText = lines[i];
                let idx = -1;
                if (isRegex) {
                  const re = new RegExp(query, caseSensitive ? '' : 'i');
                  const m = re.exec(lineText);
                  idx = m ? m.index : -1;
                } else {
                  idx = caseSensitive
                    ? lineText.indexOf(query)
                    : lineText.toLowerCase().indexOf(query.toLowerCase());
                }
                if (idx !== -1) {
                  matches.push({ file: full, line: i + 1, column: idx, text: lineText.trim() });
                }
              }
            } catch { /* skip unreadable files */ }
          }
        }
      }

      walk(resolved);
      return { query, path: resolved, matches, totalMatches: matches.length };
    }

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

function startTestServer(): Promise<number> {
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      // Health endpoint (no auth required)
      if (req.method === 'GET' && req.url === '/api/v1/health') {
        const body = makeResponse('success', {
          status: 'healthy',
          version: '0.3.0',
          uptime: process.uptime(),
          sseClients: 0,
        }, null);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
        return;
      }

      // Auth check
      const authHeader = req.headers.authorization ?? '';
      if (!authHeader.startsWith('Bearer ') || authHeader.slice(7) !== TEST_AUTH_TOKEN) {
        const body = makeResponse('error', null, 'Unauthorized: invalid or missing Bearer token');
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
        return;
      }

      // SSE endpoint
      if (req.method === 'GET' && req.url === '/api/v1/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        res.write(`event: connected\ndata: ${JSON.stringify({ message: 'SSE stream established' })}\n\n`);
        req.on('close', () => res.end());
        return;
      }

      if (req.method !== 'POST' || req.url !== '/api/v1/command') {
        const body = makeResponse('error', null, 'Not found');
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
        return;
      }

      let rawBody = '';
      req.on('data', (chunk: Buffer) => { rawBody += chunk.toString(); });
      req.on('end', () => {
        void (async () => {
          let parsed: CommandRequest;
          try {
            parsed = JSON.parse(rawBody);
          } catch {
            const body = makeResponse('error', null, 'Invalid JSON');
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(body));
            return;
          }

          const requestId = parsed.requestId ?? crypto.randomUUID();
          try {
            const data = await handleAction(parsed.action, parsed.params ?? {});
            const body = makeResponse('success', data, null, requestId);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(body));
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            const body = makeResponse('error', null, message, requestId);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(body));
          }
        })();
      });
    });

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        resolve(addr.port);
      } else {
        reject(new Error('Failed to get server address'));
      }
    });
  });
}

async function post(action: string, params?: Record<string, unknown>, requestId?: string, token: string = TEST_AUTH_TOKEN): Promise<CommandResponse> {
  const body = JSON.stringify({ action, params, requestId });
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/api/v1/command', method: 'POST', headers },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data) as CommandResponse);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeAll(async () => {
  port = await startTestServer();
});

afterAll(() => {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agbridge-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Antigravity Bridge E2E', () => {
  // -----------------------------------------------------------------------
  // ping
  // -----------------------------------------------------------------------
  it('ping returns pong', async () => {
    const res = await post('ping');
    expect(res.status).toBe('success');
    const data = res.data as { message: string; uptime: number };
    expect(data.message).toBe('pong');
    expect(typeof data.uptime).toBe('number');
  });

  // -----------------------------------------------------------------------
  // createFile
  // -----------------------------------------------------------------------
  it('createFile creates a file with content', async () => {
    const filePath = path.join(tmpDir, 'hello.txt');
    const res = await post('createFile', { path: filePath, content: 'Hello World' });
    expect(res.status).toBe('success');
    const data = res.data as { path: string };
    expect(data.path).toBe(filePath);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('Hello World');
  });

  it('createFile fails without path', async () => {
    const res = await post('createFile', {});
    expect(res.status).toBe('error');
    expect(res.error).toContain('Missing required parameter: path');
  });

  // -----------------------------------------------------------------------
  // readFile
  // -----------------------------------------------------------------------
  it('readFile returns file content', async () => {
    const filePath = path.join(tmpDir, 'read-test.txt');
    fs.writeFileSync(filePath, 'read me', 'utf-8');

    const res = await post('readFile', { path: filePath });
    expect(res.status).toBe('success');
    const data = res.data as { path: string; content: string };
    expect(data.content).toBe('read me');
  });

  it('readFile fails for non-existent file', async () => {
    const res = await post('readFile', { path: path.join(tmpDir, 'nope.txt') });
    expect(res.status).toBe('error');
    expect(res.error).toBeTruthy();
  });

  // -----------------------------------------------------------------------
  // writeFile
  // -----------------------------------------------------------------------
  it('writeFile overwrites existing content', async () => {
    const filePath = path.join(tmpDir, 'write-test.txt');
    fs.writeFileSync(filePath, 'old', 'utf-8');

    const res = await post('writeFile', { path: filePath, content: 'new content' });
    expect(res.status).toBe('success');
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('new content');
  });

  it('writeFile creates file if it does not exist', async () => {
    const filePath = path.join(tmpDir, 'sub', 'deep.txt');
    const res = await post('writeFile', { path: filePath, content: 'deep' });
    expect(res.status).toBe('success');
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('deep');
  });

  // -----------------------------------------------------------------------
  // deleteFile
  // -----------------------------------------------------------------------
  it('deleteFile removes an existing file', async () => {
    const filePath = path.join(tmpDir, 'delete-me.txt');
    fs.writeFileSync(filePath, 'bye', 'utf-8');

    const res = await post('deleteFile', { path: filePath });
    expect(res.status).toBe('success');
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('deleteFile fails for non-existent file', async () => {
    const res = await post('deleteFile', { path: path.join(tmpDir, 'ghost.txt') });
    expect(res.status).toBe('error');
  });

  // -----------------------------------------------------------------------
  // unknown action
  // -----------------------------------------------------------------------
  it('unknown action returns error', async () => {
    const res = await post('doSomethingWeird' as string);
    expect(res.status).toBe('error');
    expect(res.error).toContain('Unknown action');
  });

  // -----------------------------------------------------------------------
  // requestId passthrough
  // -----------------------------------------------------------------------
  it('preserves requestId in response', async () => {
    const id = 'test-req-123';
    const res = await post('ping', {}, id);
    expect(res.requestId).toBe(id);
  });

  // -----------------------------------------------------------------------
  // SSE endpoint
  // -----------------------------------------------------------------------
  it('SSE endpoint returns event stream with connected event', async () => {
    const events = await new Promise<string>((resolve, reject) => {
      const req = http.get(
        { hostname: '127.0.0.1', port, path: '/api/v1/events', headers: { 'Authorization': `Bearer ${TEST_AUTH_TOKEN}` } },
        (res) => {
          expect(res.headers['content-type']).toBe('text/event-stream');
          let data = '';
          res.on('data', (chunk: Buffer) => {
            data += chunk.toString();
            // After receiving the first event, close
            if (data.includes('event: connected')) {
              req.destroy();
              resolve(data);
            }
          });
          res.on('error', () => { /* expected on destroy */ });
        },
      );
      req.on('error', (err) => {
        if (err.message.includes('socket hang up')) {
          return; // expected
        }
        reject(err);
      });
    });

    expect(events).toContain('event: connected');
    expect(events).toContain('SSE stream established');
  });

  // -----------------------------------------------------------------------
  // 404
  // -----------------------------------------------------------------------
  it('returns 404 for unknown routes', async () => {
    const res = await new Promise<{ statusCode: number }>((resolve, reject) => {
      const req = http.get(
        { hostname: '127.0.0.1', port, path: '/unknown', headers: { 'Authorization': `Bearer ${TEST_AUTH_TOKEN}` } },
        (res) => {
          res.resume();
          resolve({ statusCode: res.statusCode ?? 0 });
        },
      );
      req.on('error', reject);
    });
    expect(res.statusCode).toBe(404);
  });

  // -----------------------------------------------------------------------
  // listFiles
  // -----------------------------------------------------------------------
  it('listFiles lists directory contents', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'a');
    fs.writeFileSync(path.join(tmpDir, 'b.txt'), 'b');
    fs.mkdirSync(path.join(tmpDir, 'subdir'));

    const res = await post('listFiles', { path: tmpDir });
    expect(res.status).toBe('success');
    const data = res.data as { path: string; entries: Array<{ name: string; type: string }> };
    expect(data.entries.length).toBe(3);
    const names = data.entries.map(e => e.name).sort();
    expect(names).toEqual(['a.txt', 'b.txt', 'subdir']);
    const subdir = data.entries.find(e => e.name === 'subdir');
    expect(subdir?.type).toBe('directory');
    const file = data.entries.find(e => e.name === 'a.txt');
    expect(file?.type).toBe('file');
  });

  it('listFiles fails without path', async () => {
    const res = await post('listFiles', {});
    expect(res.status).toBe('error');
    expect(res.error).toContain('Missing required parameter: path');
  });

  // -----------------------------------------------------------------------
  // executeTerminal
  // -----------------------------------------------------------------------
  it('executeTerminal runs a command and returns output', async () => {
    const res = await post('executeTerminal', { command: 'echo hello' });
    expect(res.status).toBe('success');
    const data = res.data as { executed: boolean; exitCode: number; stdout: string; stderr: string };
    expect(data.executed).toBe(true);
    expect(data.exitCode).toBe(0);
    expect(data.stdout.trim()).toBe('hello');
  });

  it('executeTerminal returns non-zero exit code on failure', async () => {
    const res = await post('executeTerminal', { command: 'exit 42' });
    expect(res.status).toBe('success');
    const data = res.data as { executed: boolean; exitCode: number };
    expect(data.executed).toBe(true);
    expect(data.exitCode).not.toBe(0);
  });

  // -----------------------------------------------------------------------
  // health endpoint
  // -----------------------------------------------------------------------
  it('GET /api/v1/health returns healthy status without auth', async () => {
    const res = await new Promise<{ statusCode: number; body: CommandResponse }>((resolve, reject) => {
      const req = http.get(
        { hostname: '127.0.0.1', port, path: '/api/v1/health' },
        (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
          res.on('end', () => {
            resolve({ statusCode: res.statusCode ?? 0, body: JSON.parse(data) });
          });
        },
      );
      req.on('error', reject);
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('success');
    const data = res.body.data as { status: string; version: string };
    expect(data.status).toBe('healthy');
    expect(data.version).toBe('0.3.0');
  });

  // -----------------------------------------------------------------------
  // auth
  // -----------------------------------------------------------------------
  it('returns 401 for requests without auth token', async () => {
    const res = await post('ping', {}, undefined, '');
    expect(res.status).toBe('error');
    expect(res.error).toContain('Unauthorized');
  });

  it('returns 401 for requests with wrong auth token', async () => {
    const res = await post('ping', {}, undefined, 'wrong-token');
    expect(res.status).toBe('error');
    expect(res.error).toContain('Unauthorized');
  });

  // -----------------------------------------------------------------------
  // getDiagnostics
  // -----------------------------------------------------------------------
  it('getDiagnostics returns diagnostics from files with markers', async () => {
    fs.writeFileSync(path.join(tmpDir, 'bad.ts'), [
      'const x = 1;',
      '// @error Unexpected token',
      'const y = 2;',
      '// @warning Unused variable',
    ].join('\n'));

    const res = await post('getDiagnostics', { path: path.join(tmpDir, 'bad.ts') });
    expect(res.status).toBe('success');
    const data = res.data as {
      diagnostics: Array<{ file: string; message: string; severity: string; range: { startLine: number } }>;
      totalCount: number; errorCount: number; warningCount: number;
    };
    expect(data.totalCount).toBe(2);
    expect(data.errorCount).toBe(1);
    expect(data.warningCount).toBe(1);
    expect(data.diagnostics[0].message).toBe('Unexpected token');
    expect(data.diagnostics[0].severity).toBe('error');
    expect(data.diagnostics[0].range.startLine).toBe(2);
    expect(data.diagnostics[1].severity).toBe('warning');
  });

  it('getDiagnostics filters by severity', async () => {
    fs.writeFileSync(path.join(tmpDir, 'mixed.ts'), [
      '// @error Critical error',
      '// @warning Minor warning',
      '// @information Just info',
      '// @hint Consider this',
    ].join('\n'));

    const res = await post('getDiagnostics', { path: path.join(tmpDir, 'mixed.ts'), severity: 'error' });
    expect(res.status).toBe('success');
    const data = res.data as { totalCount: number; diagnostics: Array<{ severity: string }> };
    expect(data.totalCount).toBe(1);
    expect(data.diagnostics[0].severity).toBe('error');
  });

  it('getDiagnostics returns empty for clean file', async () => {
    fs.writeFileSync(path.join(tmpDir, 'clean.ts'), 'const x = 1;\nconst y = 2;\n');

    const res = await post('getDiagnostics', { path: path.join(tmpDir, 'clean.ts') });
    expect(res.status).toBe('success');
    const data = res.data as { totalCount: number; diagnostics: unknown[] };
    expect(data.totalCount).toBe(0);
    expect(data.diagnostics).toEqual([]);
  });

  it('getDiagnostics scans all files when no path given', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), '// @error Error in A\n');
    fs.writeFileSync(path.join(tmpDir, 'b.ts'), '// @warning Warning in B\n');
    fs.mkdirSync(path.join(tmpDir, 'sub'));
    fs.writeFileSync(path.join(tmpDir, 'sub', 'c.ts'), '// @error Error in C\n');

    const res = await post('getDiagnostics', {});
    expect(res.status).toBe('success');
    const data = res.data as { totalCount: number; errorCount: number; warningCount: number };
    expect(data.totalCount).toBe(3);
    expect(data.errorCount).toBe(2);
    expect(data.warningCount).toBe(1);
  });

  // -----------------------------------------------------------------------
  // searchInFiles
  // -----------------------------------------------------------------------
  it('searchInFiles finds text across multiple files', async () => {
    fs.writeFileSync(path.join(tmpDir, 'foo.ts'), 'const hello = "world";\nconst bar = 42;\n');
    fs.writeFileSync(path.join(tmpDir, 'bar.ts'), 'function hello() {}\n');
    fs.mkdirSync(path.join(tmpDir, 'sub'));
    fs.writeFileSync(path.join(tmpDir, 'sub', 'deep.ts'), 'let hello = true;\n');

    const res = await post('searchInFiles', { query: 'hello', path: tmpDir });
    expect(res.status).toBe('success');
    const data = res.data as { query: string; path: string; matches: Array<{ file: string; line: number; column: number; text: string }>; totalMatches: number };
    expect(data.query).toBe('hello');
    expect(data.totalMatches).toBe(3);
    expect(data.matches.length).toBe(3);
    for (const m of data.matches) {
      expect(m.text).toContain('hello');
      expect(m.line).toBeGreaterThan(0);
      expect(m.column).toBeGreaterThanOrEqual(0);
    }
  });

  it('searchInFiles case-insensitive search', async () => {
    fs.writeFileSync(path.join(tmpDir, 'mixed.txt'), 'Hello World\nhello world\nHELLO WORLD\n');

    const res = await post('searchInFiles', { query: 'hello', path: tmpDir, caseSensitive: false });
    expect(res.status).toBe('success');
    const data = res.data as { totalMatches: number };
    expect(data.totalMatches).toBe(3);
  });

  it('searchInFiles with regex pattern', async () => {
    fs.writeFileSync(path.join(tmpDir, 'regex.ts'), 'const foo = 123;\nconst bar = 456;\nlet baz = 789;\n');

    const res = await post('searchInFiles', { query: 'const \\w+ = \\d+', path: tmpDir, regex: true });
    expect(res.status).toBe('success');
    const data = res.data as { totalMatches: number; matches: Array<{ text: string }> };
    expect(data.totalMatches).toBe(2);
  });

  it('searchInFiles returns empty for no matches', async () => {
    fs.writeFileSync(path.join(tmpDir, 'empty.txt'), 'nothing here\n');

    const res = await post('searchInFiles', { query: 'zzz_not_found_zzz', path: tmpDir });
    expect(res.status).toBe('success');
    const data = res.data as { totalMatches: number; matches: unknown[] };
    expect(data.totalMatches).toBe(0);
    expect(data.matches).toEqual([]);
  });

  it('searchInFiles fails without query', async () => {
    const res = await post('searchInFiles', {});
    expect(res.status).toBe('error');
    expect(res.error).toContain('Missing required parameter: query');
  });

  // -----------------------------------------------------------------------
  // Full flow: create → read → write → read → delete → read(fail)
  // -----------------------------------------------------------------------
  it('full CRUD flow works end-to-end', async () => {
    const filePath = path.join(tmpDir, 'crud-test.txt');

    // Create
    const c = await post('createFile', { path: filePath, content: 'v1' });
    expect(c.status).toBe('success');

    // Read
    const r1 = await post('readFile', { path: filePath });
    expect((r1.data as { content: string }).content).toBe('v1');

    // Write (overwrite)
    const w = await post('writeFile', { path: filePath, content: 'v2' });
    expect(w.status).toBe('success');

    // Read again
    const r2 = await post('readFile', { path: filePath });
    expect((r2.data as { content: string }).content).toBe('v2');

    // Delete
    const d = await post('deleteFile', { path: filePath });
    expect(d.status).toBe('success');

    // Read should fail
    const r3 = await post('readFile', { path: filePath });
    expect(r3.status).toBe('error');
  });
});
