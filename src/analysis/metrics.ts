import type { TranscriptEvent, TranscriptSession } from "../types/transcript.js";
import { classifyPrivacy } from "../privacy/policy.js";
import { getTimestampRange } from "./time.js";

export type ProfileMetrics = {
  sessionCount: number;
  eventCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  toolCallCount: number;
  averageUserPromptChars: number;
  planningSignalCount: number;
  debuggingSignalCount: number;
  reviewSignalCount: number;
  redirectSignalCount: number;
  topTools: Array<{ name: string; count: number }>;
  topFileRefs: Array<{ path: string; count: number }>;
  commonUserPhrases: Array<{ phrase: string; count: number }>;
  firstTimestamp?: string;
  lastTimestamp?: string;
};

const PLANNING_RE = /\b(plan|planning|think|approach|architecture|design|scope|trade-?off)\b/i;
const DEBUGGING_RE = /\b(error|bug|debug|failing|failed|fix|issue|lint|test)\b/i;
const REVIEW_RE = /\b(review|feedback|check|audit|look over)\b/i;
const REDIRECT_RE = /\b(no|stop|instead|actually|don't|do not|wrong|not that|change)\b/i;

export function computeProfileMetrics(sessions: TranscriptSession[]): ProfileMetrics {
  const events = sessions.flatMap((session) => session.events);
  const userEvents = events.filter((event) => event.role === "user");
  const assistantEvents = events.filter((event) => event.role === "assistant");
  const toolEvents = events.filter((event) => event.role === "tool");
  const timestampRange = getTimestampRange(events);

  return {
    sessionCount: sessions.length,
    eventCount: events.length,
    userMessageCount: userEvents.length,
    assistantMessageCount: assistantEvents.length,
    toolCallCount: toolEvents.length,
    averageUserPromptChars: average(userEvents.map((event) => event.text.length)),
    planningSignalCount: countMatches(userEvents, PLANNING_RE),
    debuggingSignalCount: countMatches(userEvents, DEBUGGING_RE),
    reviewSignalCount: countMatches(userEvents, REVIEW_RE),
    redirectSignalCount: countMatches(userEvents, REDIRECT_RE),
    topTools: topCounts(toolEvents.map((event) => event.toolName).filter(isPresent), 10).map(({ value, count }) => ({
      name: value,
      count,
    })),
    topFileRefs: topCounts(events.flatMap((event) => event.fileRefs), 10).map(({ value, count }) => ({
      path: value,
      count,
    })),
    commonUserPhrases: topCounts(
      userEvents.filter((event) => classifyPrivacy(event.text).includeInLocalReport).flatMap((event) => extractPhrases(event.text)),
      10,
    ).map(({ value, count }) => ({
      phrase: value,
      count,
    })),
    ...timestampRange,
  };
}

export function selectRepresentativeUserEvents(sessions: TranscriptSession[], limit = 8): TranscriptEvent[] {
  const userEvents = sessions
    .flatMap((session) => session.events)
    .filter((event) => event.role === "user" && classifyPrivacy(event.text).includeInLocalReport);
  const buckets = [
    userEvents.filter((event) => PLANNING_RE.test(event.text)),
    userEvents.filter((event) => DEBUGGING_RE.test(event.text)),
    userEvents.filter((event) => REVIEW_RE.test(event.text)),
    userEvents.filter((event) => REDIRECT_RE.test(event.text)),
    userEvents,
  ];
  const selected = new Map<string, TranscriptEvent>();

  for (const bucket of buckets) {
    for (const event of bucket) {
      selected.set(`${event.sessionId}:${event.rawLine}`, event);
      if (selected.size >= limit) {
        return [...selected.values()];
      }
    }
  }

  return [...selected.values()];
}

function countMatches(events: TranscriptEvent[], pattern: RegExp): number {
  return events.filter((event) => pattern.test(event.text)).length;
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function topCounts(values: string[], limit: number): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

function extractPhrases(text: string): string[] {
  const normalized = text
    .toLowerCase()
    .replace(/<timestamp>.*?<\/timestamp>/gis, " ")
    .replace(/<\/?user_query>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[^a-z0-9\s'-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && word.length < 24);

  const phrases: string[] = [];
  for (let index = 0; index < normalized.length - 2; index += 1) {
    phrases.push(normalized.slice(index, index + 3).join(" "));
  }

  return phrases;
}

function isPresent(value: string | undefined): value is string {
  return Boolean(value);
}
