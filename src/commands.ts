import * as vscode from 'vscode';
import * as path from 'path';
import { logger } from './logger';

const FILE_TIMEOUT = 30_000;
const TERMINAL_TIMEOUT = 60_000;

function toPromise<T>(thenable: Thenable<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => thenable.then(resolve, reject));
}

function withTimeout<T>(thenable: Thenable<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    thenable.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export async function handlePing(): Promise<{ message: string; uptime: number }> {
  return { message: 'pong', uptime: process.uptime() };
}

export async function handleCreateFile(params: Record<string, unknown>): Promise<{ path: string }> {
  const filePath = String(params.path ?? '');
  const content = String(params.content ?? '');
  if (!filePath) {
    throw new Error('Missing required parameter: path');
  }
  const uri = resolveUri(filePath);
  await withTimeout(
    vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8')),
    FILE_TIMEOUT,
    'createFile',
  );
  logger.info(`Created file: ${uri.fsPath}`);
  return { path: uri.fsPath };
}

export async function handleReadFile(params: Record<string, unknown>): Promise<{ path: string; content: string }> {
  const filePath = String(params.path ?? '');
  if (!filePath) {
    throw new Error('Missing required parameter: path');
  }
  const uri = resolveUri(filePath);
  const data = await withTimeout(
    vscode.workspace.fs.readFile(uri),
    FILE_TIMEOUT,
    'readFile',
  );
  const content = Buffer.from(data).toString('utf-8');
  logger.info(`Read file: ${uri.fsPath} (${data.byteLength} bytes)`);
  return { path: uri.fsPath, content };
}

export async function handleWriteFile(params: Record<string, unknown>): Promise<{ path: string }> {
  const filePath = String(params.path ?? '');
  const content = String(params.content ?? '');
  if (!filePath) {
    throw new Error('Missing required parameter: path');
  }
  const uri = resolveUri(filePath);
  await withTimeout(
    vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8')),
    FILE_TIMEOUT,
    'writeFile',
  );
  logger.info(`Wrote file: ${uri.fsPath}`);
  return { path: uri.fsPath };
}

export async function handleDeleteFile(params: Record<string, unknown>): Promise<{ path: string }> {
  const filePath = String(params.path ?? '');
  if (!filePath) {
    throw new Error('Missing required parameter: path');
  }
  const uri = resolveUri(filePath);
  await withTimeout(
    vscode.workspace.fs.delete(uri, { recursive: false }),
    FILE_TIMEOUT,
    'deleteFile',
  );
  logger.info(`Deleted file: ${uri.fsPath}`);
  return { path: uri.fsPath };
}

export async function handleOpenFile(params: Record<string, unknown>): Promise<{ path: string }> {
  const filePath = String(params.path ?? '');
  const preview = params.preview !== false;
  if (!filePath) {
    throw new Error('Missing required parameter: path');
  }
  const uri = resolveUri(filePath);
  await withTimeout(
    (async () => {
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview });
    })(),
    FILE_TIMEOUT,
    'openFile',
  );
  logger.info(`Opened file: ${uri.fsPath}`);
  return { path: uri.fsPath };
}

export async function handleExecuteTerminal(params: Record<string, unknown>): Promise<{ executed: boolean }> {
  const command = String(params.command ?? '');
  const cwd = params.cwd ? String(params.cwd) : undefined;
  if (!command) {
    throw new Error('Missing required parameter: command');
  }

  return withTimeout(
    new Promise<{ executed: boolean }>((resolve) => {
      const terminal = vscode.window.createTerminal({
        name: 'Antigravity Bridge',
        cwd,
      });
      terminal.show(false);
      terminal.sendText(command, true);
      logger.info(`Executed terminal command: ${command}`);
      // Terminal commands are fire-and-forget in VS Code API
      resolve({ executed: true });
    }),
    TERMINAL_TIMEOUT,
    'executeTerminal',
  );
}

export async function handleGetWorkspaceFolders(): Promise<{ folders: Array<{ name: string; uri: string }> }> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const result = folders.map((f) => ({ name: f.name, uri: f.uri.fsPath }));
  logger.info(`Workspace folders: ${result.length}`);
  return { folders: result };
}

function resolveUri(filePath: string): vscode.Uri {
  if (path.isAbsolute(filePath)) {
    return vscode.Uri.file(filePath);
  }
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!workspaceRoot) {
    throw new Error('No workspace folder open. Use an absolute path or open a workspace first.');
  }
  return vscode.Uri.joinPath(workspaceRoot, filePath);
}
