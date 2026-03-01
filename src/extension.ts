import * as vscode from 'vscode';
import { BridgeServer } from './server';
import { FileWatcher } from './fileWatcher';
import { logger } from './logger';
import { BridgeConfig } from './types';

let server: BridgeServer | undefined;
let fileWatcher: FileWatcher | undefined;

function getConfig(): BridgeConfig {
  const cfg = vscode.workspace.getConfiguration('antigravityBridge');
  return {
    enabled: cfg.get<boolean>('enabled', true),
    port: cfg.get<number>('port', 55678),
    host: cfg.get<string>('host', '127.0.0.1'),
    webhookUrl: cfg.get<string>('webhookUrl', ''),
    logLevel: cfg.get<'debug' | 'info' | 'warn' | 'error'>('logLevel', 'info'),
    authToken: cfg.get<string>('authToken', ''),
  };
}

async function startServer(): Promise<void> {
  const config = getConfig();
  logger.setLevel(config.logLevel);

  if (!config.enabled) {
    logger.info('Bridge server is disabled via settings.');
    return;
  }

  server = new BridgeServer();
  const port = await server.start(config);

  fileWatcher = new FileWatcher();
  fileWatcher.start(config.webhookUrl);

  vscode.window.showInformationMessage(`Antigravity Bridge running on ${config.host}:${port}`);
}

async function stopServer(): Promise<void> {
  fileWatcher?.dispose();
  fileWatcher = undefined;
  await server?.stop();
  server = undefined;
  vscode.window.showInformationMessage('Antigravity Bridge stopped.');
}

export function activate(context: vscode.ExtensionContext): void {
  logger.info('Antigravity Bridge extension activating...');

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravityBridge.start', async () => {
      try {
        await startServer();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Failed to start server: ${msg}`);
        vscode.window.showErrorMessage(`Antigravity Bridge: ${msg}`);
      }
    }),

    vscode.commands.registerCommand('antigravityBridge.stop', async () => {
      await stopServer();
    }),

    vscode.commands.registerCommand('antigravityBridge.restart', async () => {
      await stopServer();
      try {
        await startServer();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Failed to restart server: ${msg}`);
        vscode.window.showErrorMessage(`Antigravity Bridge: ${msg}`);
      }
    }),

    vscode.commands.registerCommand('antigravityBridge.showStatus', () => {
      const port = server?.actualPort;
      if (port) {
        vscode.window.showInformationMessage(`Antigravity Bridge is running on port ${port}.`);
      } else {
        vscode.window.showInformationMessage('Antigravity Bridge is not running.');
      }
      logger.show();
    }),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('antigravityBridge')) {
        logger.info('Configuration changed. Restart the server to apply.');
      }
    }),
  );

  // Auto-start
  startServer().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Auto-start failed: ${msg}`);
  });
}

export function deactivate(): Promise<void> {
  logger.info('Antigravity Bridge extension deactivating...');
  fileWatcher?.dispose();
  logger.dispose();
  return server?.stop() ?? Promise.resolve();
}
