export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type ActionType =
  | 'ping'
  | 'createFile'
  | 'readFile'
  | 'writeFile'
  | 'deleteFile'
  | 'openFile'
  | 'executeTerminal'
  | 'getWorkspaceFolders';

export interface CommandRequest {
  action: ActionType;
  params?: Record<string, unknown>;
  requestId?: string;
}

export interface CommandResponse {
  status: 'success' | 'error';
  data: unknown;
  error: string | null;
  requestId: string;
  timestamp: string;
}

export interface BridgeConfig {
  enabled: boolean;
  port: number;
  host: string;
  webhookUrl: string;
  logLevel: LogLevel;
}

export interface FileChangeEvent {
  type: 'created' | 'changed' | 'deleted';
  uri: string;
  timestamp: string;
}

export interface TerminalResult {
  executed: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export type SSEEventType = 'file-change' | 'task-complete' | 'connected';

export interface SSEEvent {
  event: SSEEventType;
  data: unknown;
  id?: string;
}
