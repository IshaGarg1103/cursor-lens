export type TranscriptRole = "user" | "assistant" | "tool" | "system" | "unknown";

export type TranscriptEvent = {
  sessionId: string;
  sourcePath: string;
  role: TranscriptRole;
  text: string;
  timestamp?: string;
  model?: string;
  toolName?: string;
  fileRefs: string[];
  rawLine: number;
};

export type TranscriptSession = {
  id: string;
  sourcePath: string;
  workspaceKey: string;
  workspacePath?: string;
  isSubagent: boolean;
  events: TranscriptEvent[];
  parseErrors: ParseError[];
};

export type ParseError = {
  line: number;
  message: string;
};

export type WorkspaceSummary = {
  key: string;
  displayName: string;
  inferredPath?: string;
  transcriptRoot: string;
  sessionCount: number;
  eventCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  toolCallCount: number;
  firstTimestamp?: string;
  lastTimestamp?: string;
};

export type ScanResult = {
  scannedRoots: string[];
  workspaces: WorkspaceSummary[];
  sessions: TranscriptSession[];
  errors: string[];
};
