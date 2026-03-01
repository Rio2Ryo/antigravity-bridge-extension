import * as http from 'http';
import * as crypto from 'crypto';
import { CommandRequest, CommandResponse, ActionType, BridgeConfig, SSEEvent } from './types';
import { logger } from './logger';
import { eventBus } from './eventBus';
import {
  handlePing,
  handleCreateFile,
  handleReadFile,
  handleWriteFile,
  handleDeleteFile,
  handleListFiles,
  handleOpenFile,
  handleExecuteTerminal,
  handleGetWorkspaceFolders,
  handleSearchInFiles,
  handleGetDiagnostics,
} from './commands';

const MAX_PORT_ATTEMPTS = 10;

type ActionHandler = (params: Record<string, unknown>) => Promise<unknown>;

const ACTION_HANDLERS: Record<ActionType, ActionHandler> = {
  ping: () => handlePing(),
  createFile: (p) => handleCreateFile(p),
  readFile: (p) => handleReadFile(p),
  writeFile: (p) => handleWriteFile(p),
  deleteFile: (p) => handleDeleteFile(p),
  listFiles: (p) => handleListFiles(p),
  openFile: (p) => handleOpenFile(p),
  executeTerminal: (p) => handleExecuteTerminal(p),
  getWorkspaceFolders: () => handleGetWorkspaceFolders(),
  searchInFiles: (p) => handleSearchInFiles(p),
  getDiagnostics: (p) => handleGetDiagnostics(p),
};

export class BridgeServer {
  private server: http.Server | undefined;
  private _actualPort: number | undefined;
  private sseClients: Set<http.ServerResponse> = new Set();
  private authToken: string = '';

  get actualPort(): number | undefined {
    return this._actualPort;
  }

  async start(config: BridgeConfig): Promise<number> {
    if (this.server) {
      await this.stop();
    }

    this.authToken = config.authToken ?? '';

    // Listen for SSE events from the bus
    eventBus.on('sse', (event: SSEEvent) => this.broadcastSSE(event));

    const port = await this.listen(config.host, config.port);
    this._actualPort = port;
    logger.info(`Bridge server listening on ${config.host}:${port}`);
    return port;
  }

  async stop(): Promise<void> {
    eventBus.removeAllListeners('sse');
    // Close all SSE connections
    for (const client of this.sseClients) {
      client.end();
    }
    this.sseClients.clear();

    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => {
        this.server = undefined;
        this._actualPort = undefined;
        logger.info('Bridge server stopped.');
        resolve();
      });
    });
  }

  private async listen(host: string, startPort: number): Promise<number> {
    for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
      const port = startPort + attempt;
      try {
        await this.tryListen(host, port);
        return port;
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EADDRINUSE') {
          logger.warn(`Port ${port} in use, trying ${port + 1}...`);
          continue;
        }
        throw err;
      }
    }
    throw new Error(`Could not find an available port after ${MAX_PORT_ATTEMPTS} attempts (starting from ${startPort}).`);
  }

  private tryListen(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => this.handleRequest(req, res, host));
      srv.once('error', reject);
      srv.listen(port, host, () => {
        srv.removeListener('error', reject);
        this.server = srv;
        resolve();
      });
    });
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse, allowedHost: string): void {
    // CORS — localhost only by default
    const origin = req.headers.origin ?? '';
    const allowed = this.isOriginAllowed(origin, allowedHost);

    if (allowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health endpoint (no auth required)
    if (req.method === 'GET' && req.url === '/api/v1/health') {
      this.sendJson(res, 200, this.makeResponse('success', {
        status: 'healthy',
        version: '0.3.0',
        uptime: process.uptime(),
        sseClients: this.sseClients.size,
      }, null));
      return;
    }

    // Auth check (skip if no token configured)
    if (this.authToken && !this.checkAuth(req)) {
      this.sendJson(res, 401, this.makeResponse('error', null, 'Unauthorized: invalid or missing Bearer token'));
      return;
    }

    // SSE endpoint
    if (req.method === 'GET' && req.url === '/api/v1/events') {
      this.handleSSE(req, res);
      return;
    }

    if (req.method !== 'POST' || req.url !== '/api/v1/command') {
      this.sendJson(res, 404, this.makeResponse('error', null, 'Not found'));
      return;
    }

    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > 1_048_576) {
        this.sendJson(res, 413, this.makeResponse('error', null, 'Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      void this.dispatch(body, res);
    });
  }

  private handleSSE(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    // Send connected event
    this.writeSSE(res, {
      event: 'connected',
      data: { message: 'SSE stream established', timestamp: new Date().toISOString() },
      id: '0',
    });

    this.sseClients.add(res);
    logger.info(`SSE client connected (total: ${this.sseClients.size})`);

    req.on('close', () => {
      this.sseClients.delete(res);
      logger.info(`SSE client disconnected (total: ${this.sseClients.size})`);
    });
  }

  private broadcastSSE(event: SSEEvent): void {
    for (const client of this.sseClients) {
      this.writeSSE(client, event);
    }
  }

  private writeSSE(res: http.ServerResponse, event: SSEEvent): void {
    if (event.id) {
      res.write(`id: ${event.id}\n`);
    }
    res.write(`event: ${event.event}\n`);
    res.write(`data: ${JSON.stringify(event.data)}\n\n`);
  }

  private async dispatch(body: string, res: http.ServerResponse): Promise<void> {
    let parsed: CommandRequest;
    try {
      parsed = JSON.parse(body) as CommandRequest;
    } catch {
      this.sendJson(res, 400, this.makeResponse('error', null, 'Invalid JSON'));
      return;
    }

    const requestId = parsed.requestId ?? crypto.randomUUID();
    const action = parsed.action;

    if (!action || !(action in ACTION_HANDLERS)) {
      this.sendJson(res, 400, this.makeResponse('error', null, `Unknown action: ${String(action)}`, requestId));
      return;
    }

    logger.debug(`Dispatching action: ${action}`, parsed.params);

    try {
      const data = await ACTION_HANDLERS[action](parsed.params ?? {});
      this.sendJson(res, 200, this.makeResponse('success', data, null, requestId));

      // Emit task-complete event for SSE subscribers
      eventBus.publish('task-complete', {
        action,
        requestId,
        status: 'success',
        timestamp: new Date().toISOString(),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Action ${action} failed: ${message}`);
      this.sendJson(res, 500, this.makeResponse('error', null, message, requestId));

      eventBus.publish('task-complete', {
        action,
        requestId,
        status: 'error',
        error: message,
        timestamp: new Date().toISOString(),
      });
    }
  }

  private checkAuth(req: http.IncomingMessage): boolean {
    const authHeader = req.headers.authorization ?? '';
    if (authHeader.startsWith('Bearer ')) {
      return authHeader.slice(7) === this.authToken;
    }
    return false;
  }

  private isOriginAllowed(origin: string, allowedHost: string): boolean {
    if (!origin) {
      return true; // non-browser clients (curl, agent SDKs)
    }
    try {
      const url = new URL(origin);
      return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === allowedHost;
    } catch {
      return false;
    }
  }

  private makeResponse(status: 'success' | 'error', data: unknown, error: string | null, requestId?: string): CommandResponse {
    return {
      status,
      data,
      error,
      requestId: requestId ?? crypto.randomUUID(),
      timestamp: new Date().toISOString(),
    };
  }

  private sendJson(res: http.ServerResponse, statusCode: number, body: CommandResponse): void {
    const json = JSON.stringify(body);
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(json);
  }
}
