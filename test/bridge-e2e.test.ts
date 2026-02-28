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

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

function startTestServer(): Promise<number> {
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
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

async function post(action: string, params?: Record<string, unknown>, requestId?: string): Promise<CommandResponse> {
  const body = JSON.stringify({ action, params, requestId });
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/api/v1/command', method: 'POST', headers: { 'Content-Type': 'application/json' } },
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
        { hostname: '127.0.0.1', port, path: '/api/v1/events' },
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
        { hostname: '127.0.0.1', port, path: '/unknown' },
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
