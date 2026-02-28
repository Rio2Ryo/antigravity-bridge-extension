import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import { FileChangeEvent } from './types';
import { logger } from './logger';
import { eventBus } from './eventBus';

export class FileWatcher {
  private watcher: vscode.FileSystemWatcher | undefined;
  private disposables: vscode.Disposable[] = [];

  start(webhookUrl: string): void {
    if (this.watcher) {
      this.dispose();
    }

    this.watcher = vscode.workspace.createFileSystemWatcher('**/*');

    const emit = (event: FileChangeEvent): void => {
      // Always publish to SSE bus
      eventBus.publish('file-change', event);
      // Also send webhook if configured
      if (webhookUrl) {
        this.notify(webhookUrl, event);
      }
    };

    this.disposables.push(
      this.watcher.onDidCreate((uri) => emit({ type: 'created', uri: uri.fsPath, timestamp: new Date().toISOString() })),
      this.watcher.onDidChange((uri) => emit({ type: 'changed', uri: uri.fsPath, timestamp: new Date().toISOString() })),
      this.watcher.onDidDelete((uri) => emit({ type: 'deleted', uri: uri.fsPath, timestamp: new Date().toISOString() })),
    );

    logger.info(`File watcher started${webhookUrl ? `, webhook: ${webhookUrl}` : ' (SSE only)'}`);
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
    this.watcher?.dispose();
    this.watcher = undefined;
    logger.debug('File watcher disposed.');
  }

  private notify(webhookUrl: string, event: FileChangeEvent): void {
    const body = JSON.stringify(event);
    const url = new URL(webhookUrl);
    const transport = url.protocol === 'https:' ? https : http;

    const req = transport.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 5000,
      },
      (res) => {
        logger.debug(`Webhook response: ${res.statusCode} for ${event.type} ${event.uri}`);
        res.resume(); // drain
      },
    );
    req.on('error', (err) => {
      logger.warn(`Webhook request failed: ${err.message}`);
    });
    req.write(body);
    req.end();
  }
}
