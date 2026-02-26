import * as vscode from 'vscode';
import { LogLevel } from './types';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export class Logger {
  private outputChannel: vscode.OutputChannel;
  private level: LogLevel = 'info';

  constructor() {
    this.outputChannel = vscode.window.createOutputChannel('Antigravity Bridge');
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  debug(message: string, ...args: unknown[]): void {
    this.log('debug', message, ...args);
  }

  info(message: string, ...args: unknown[]): void {
    this.log('info', message, ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.log('warn', message, ...args);
  }

  error(message: string, ...args: unknown[]): void {
    this.log('error', message, ...args);
  }

  show(): void {
    this.outputChannel.show(true);
  }

  dispose(): void {
    this.outputChannel.dispose();
  }

  private log(level: LogLevel, message: string, ...args: unknown[]): void {
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[this.level]) {
      return;
    }
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${level.toUpperCase()}]`;
    const suffix = args.length > 0 ? ' ' + args.map(a => JSON.stringify(a)).join(' ') : '';
    this.outputChannel.appendLine(`${prefix} ${message}${suffix}`);
  }
}

export const logger = new Logger();
