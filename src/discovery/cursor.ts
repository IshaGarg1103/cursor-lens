import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { getTimestampRange } from "../analysis/time.js";
import { inferWorkspaceKeyFromTranscriptPath, parseCursorTranscriptFile } from "../parsers/cursorTranscript.js";
import type { ScanResult, TranscriptSession, WorkspaceSummary } from "../types/transcript.js";

export type ScanOptions = {
  cursorProjectsDir?: string;
  includeSubagents?: boolean;
};

export async function scanCursorTranscripts(options: ScanOptions = {}): Promise<ScanResult> {
  const cursorProjectsDir = resolve(
    expandHome(options.cursorProjectsDir ?? process.env.CURSOR_PROJECTS_DIR ?? "~/.cursor/projects"),
  );
  const errors: string[] = [];
  const sessions: TranscriptSession[] = [];
  const scannedRoots: string[] = [];

  const projectDirs = await listDirectories(cursorProjectsDir).catch((error: unknown) => {
    errors.push(`Could not read Cursor projects dir ${cursorProjectsDir}: ${formatError(error)}`);
    return [];
  });

  for (const projectDir of projectDirs) {
    const transcriptRoot = join(projectDir, "agent-transcripts");
    if (!(await pathExists(transcriptRoot))) {
      continue;
    }

    scannedRoots.push(transcriptRoot);
    const files = await collectJsonlFiles(transcriptRoot, {
      includeSubagents: options.includeSubagents ?? false,
    }).catch((error: unknown) => {
      errors.push(`Could not scan ${transcriptRoot}: ${formatError(error)}`);
      return [];
    });

    for (const file of files) {
      const workspaceKey = inferWorkspaceKeyFromTranscriptPath(file);
      const workspacePath = await inferExistingWorkspacePathFromKey(workspaceKey);
      try {
        sessions.push(await parseCursorTranscriptFile(file, workspaceKey, workspacePath));
      } catch (error) {
        errors.push(`Could not parse ${file}: ${formatError(error)}`);
      }
    }
  }

  return {
    scannedRoots,
    sessions,
    workspaces: summarizeWorkspaces(sessions),
    errors,
  };
}

export function summarizeWorkspaces(sessions: TranscriptSession[]): WorkspaceSummary[] {
  const byWorkspace = new Map<string, TranscriptSession[]>();
  for (const session of sessions) {
    const existing = byWorkspace.get(session.workspaceKey) ?? [];
    existing.push(session);
    byWorkspace.set(session.workspaceKey, existing);
  }

  return [...byWorkspace.entries()]
    .map(([key, workspaceSessions]) => {
      const events = workspaceSessions.flatMap((session) => session.events);
      const timestampRange = getTimestampRange(events);
      const toolCallCount = events.filter((event) => event.role === "tool").length;
      const transcriptRoot = inferTranscriptRoot(workspaceSessions[0]?.sourcePath ?? "");
      const inferredPath = workspaceSessions.find((session) => session.workspacePath)?.workspacePath;

      return {
        key,
        displayName: inferredPath ? basename(inferredPath) : displayNameFromWorkspaceKey(key),
        ...(inferredPath ? { inferredPath } : {}),
        transcriptRoot,
        sessionCount: workspaceSessions.length,
        eventCount: events.length,
        userMessageCount: events.filter((event) => event.role === "user").length,
        assistantMessageCount: events.filter((event) => event.role === "assistant").length,
        toolCallCount,
        ...timestampRange,
      };
    })
    .sort((a, b) => b.sessionCount - a.sessionCount || a.displayName.localeCompare(b.displayName));
}

function displayNameFromWorkspaceKey(key: string): string {
  const match = key.match(/^Users-[^-]+-(.+)$/);
  return match?.[1] ?? key;
}

export async function collectJsonlFiles(
  root: string,
  options: { includeSubagents: boolean },
): Promise<string[]> {
  const result: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      if (!options.includeSubagents && entry.name === "subagents") {
        continue;
      }
      result.push(...(await collectJsonlFiles(fullPath, options)));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      if (!options.includeSubagents && fullPath.split(sep).includes("subagents")) {
        continue;
      }
      result.push(fullPath);
    }
  }

  return result.sort();
}

async function listDirectories(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))
    .sort();
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function inferTranscriptRoot(sourcePath: string): string {
  const parts = sourcePath.split(sep);
  const index = parts.lastIndexOf("agent-transcripts");
  if (index === -1) {
    return "";
  }

  return parts.slice(0, index + 1).join(sep) || sep;
}

async function inferExistingWorkspacePathFromKey(key: string): Promise<string | undefined> {
  if (!key.startsWith("Users-")) {
    return undefined;
  }

  const parts = key.split("-");
  if (parts.length < 2) {
    return undefined;
  }

  const candidate = sep + parts.join(sep);
  return (await pathExists(candidate)) ? candidate : undefined;
}

function expandHome(path: string): string {
  if (path === "~") {
    return homedir();
  }

  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }

  return path;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
