export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type ActionType =
  | 'ping'
  | 'createFile'
  | 'readFile'
  | 'writeFile'
  | 'deleteFile'
  | 'listFiles'
  | 'openFile'
  | 'executeTerminal'
  | 'getWorkspaceFolders'
  | 'searchInFiles'
  | 'getDiagnostics'
  | 'getActiveEditor'
  | 'getOpenEditors';

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
  authToken: string;
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

export interface SearchMatch {
  file: string;
  line: number;
  column: number;
  text: string;
}

export interface SearchResult {
  query: string;
  path: string;
  matches: SearchMatch[];
  totalMatches: number;
}

export type DiagnosticSeverityName = 'error' | 'warning' | 'information' | 'hint';

export interface DiagnosticItem {
  file: string;
  range: {
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  };
  message: string;
  severity: DiagnosticSeverityName;
  source: string;
  code: string;
}

export interface DiagnosticsResult {
  diagnostics: DiagnosticItem[];
  totalCount: number;
  errorCount: number;
  warningCount: number;
  informationCount: number;
  hintCount: number;
}

export interface EditorInfo {
  file: string;
  languageId: string;
  lineCount: number;
  isDirty: boolean;
  selection: {
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
    isEmpty: boolean;
  };
  visibleRange: {
    startLine: number;
    endLine: number;
  };
}

export interface EditorTabInfo {
  file: string;
  isActive: boolean;
  isDirty: boolean;
  label: string;
  groupIndex: number;
}

export type SSEEventType = 'file-change' | 'task-complete' | 'connected';

export interface SSEEvent {
  event: SSEEventType;
  data: unknown;
  id?: string;
}
