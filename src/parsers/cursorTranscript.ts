import { readFile } from "node:fs/promises";
import { basename, dirname, sep } from "node:path";
import type { ParseError, TranscriptEvent, TranscriptRole, TranscriptSession } from "../types/transcript.js";

type CursorContentPart = {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
};

type CursorLine = {
  role?: string;
  message?: {
    content?: string | CursorContentPart[];
    model?: string;
  };
  timestamp?: string;
  model?: string;
};

type CursorMessageContent = NonNullable<CursorLine["message"]>["content"];

const TIMESTAMP_RE = /<timestamp>(.*?)<\/timestamp>/;
const ABS_PATH_RE = /\/Users\/[^\s"'`),]+(?:\/[^\s"'`),]+)*/g;
const BACKTICK_PATH_RE = /`([^`]+\.(?:ts|tsx|js|jsx|json|md|py|go|rs|java|css|html|yml|yaml|toml|sh))`/g;

export async function parseCursorTranscriptFile(
  sourcePath: string,
  workspaceKey: string,
  workspacePath?: string,
): Promise<TranscriptSession> {
  const text = await readFile(sourcePath, "utf8");
  const sessionId = basename(sourcePath, ".jsonl");
  const isSubagent = sourcePath.split(sep).includes("subagents");
  const events: TranscriptEvent[] = [];
  const parseErrors: ParseError[] = [];

  text.split(/\r?\n/).forEach((line, index) => {
    const lineNumber = index + 1;
    if (!line.trim()) {
      return;
    }

    try {
      const raw = JSON.parse(line) as CursorLine;
      events.push(...normalizeCursorLine(raw, sourcePath, sessionId, lineNumber));
    } catch (error) {
      parseErrors.push({
        line: lineNumber,
        message: error instanceof Error ? error.message : "Unknown JSON parse error",
      });
    }
  });

  return {
    id: sessionId,
    sourcePath,
    workspaceKey,
    ...(workspacePath ? { workspacePath } : {}),
    isSubagent,
    events,
    parseErrors,
  };
}

export function inferWorkspaceKeyFromTranscriptPath(sourcePath: string): string {
  const parts = sourcePath.split(sep);
  const agentTranscriptsIndex = parts.lastIndexOf("agent-transcripts");
  if (agentTranscriptsIndex > 0) {
    return parts[agentTranscriptsIndex - 1] ?? dirname(sourcePath);
  }

  return dirname(sourcePath);
}

function normalizeCursorLine(
  raw: CursorLine,
  sourcePath: string,
  sessionId: string,
  rawLine: number,
): TranscriptEvent[] {
  const role = normalizeRole(raw.role);
  const model = raw.model ?? raw.message?.model;
  const content = raw.message?.content;
  const timestamp = raw.timestamp ?? extractTimestampFromContent(content);

  if (Array.isArray(content)) {
    return content
      .map((part): TranscriptEvent | undefined => {
        if (part.type === "tool_use") {
          const text = stringifyToolInput(part.input);
          return {
            sessionId,
            sourcePath,
            role: "tool",
            text,
            ...(timestamp ? { timestamp } : {}),
            ...(model ? { model } : {}),
            ...(part.name ? { toolName: part.name } : {}),
            fileRefs: extractFileRefs(text),
            rawLine,
          };
        }

        if (typeof part.text === "string") {
          return {
            sessionId,
            sourcePath,
            role,
            text: part.text,
            ...(timestamp ? { timestamp } : {}),
            ...(model ? { model } : {}),
            fileRefs: extractFileRefs(part.text),
            rawLine,
          };
        }

        return undefined;
      })
      .filter((event): event is TranscriptEvent => event !== undefined);
  }

  const text = typeof content === "string" ? content : "";
  return [
    {
      sessionId,
      sourcePath,
      role,
      text,
      ...(timestamp ? { timestamp } : {}),
      ...(model ? { model } : {}),
      fileRefs: extractFileRefs(text),
      rawLine,
    },
  ];
}

function normalizeRole(role: string | undefined): TranscriptRole {
  if (role === "user" || role === "assistant" || role === "tool" || role === "system") {
    return role;
  }

  return "unknown";
}

function extractTimestampFromContent(content: CursorMessageContent | undefined): string | undefined {
  const text = Array.isArray(content)
    ? content.map((part) => part.text ?? "").join("\n")
    : content;
  if (!text) {
    return undefined;
  }

  return text.match(TIMESTAMP_RE)?.[1];
}

function stringifyToolInput(input: unknown): string {
  if (input === undefined) {
    return "";
  }

  if (typeof input === "string") {
    return input;
  }

  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

function extractFileRefs(text: string): string[] {
  const refs = new Set<string>();
  for (const match of text.matchAll(ABS_PATH_RE)) {
    refs.add(match[0]);
  }
  for (const match of text.matchAll(BACKTICK_PATH_RE)) {
    if (match[1]) {
      refs.add(match[1]);
    }
  }

  return [...refs];
}
