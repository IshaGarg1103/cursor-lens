import type { TranscriptEvent } from "../types/transcript.js";

const MONTHS = new Map<string, number>([
  ["jan", 0],
  ["january", 0],
  ["feb", 1],
  ["february", 1],
  ["mar", 2],
  ["march", 2],
  ["apr", 3],
  ["april", 3],
  ["may", 4],
  ["jun", 5],
  ["june", 5],
  ["jul", 6],
  ["july", 6],
  ["aug", 7],
  ["august", 7],
  ["sep", 8],
  ["sept", 8],
  ["september", 8],
  ["oct", 9],
  ["october", 9],
  ["nov", 10],
  ["november", 10],
  ["dec", 11],
  ["december", 11],
]);

const CURSOR_TIMESTAMP_RE =
  /^(?:\w+,\s*)?(\w+)\s+(\d{1,2}),\s+(\d{4}),\s+(\d{1,2}):(\d{2})\s+(AM|PM)\s+\(UTC([+-])(\d{1,2}):(\d{2})\)$/i;

export function getTimestampRange(events: TranscriptEvent[]): { firstTimestamp?: string; lastTimestamp?: string } {
  const parsed = events
    .map((event, index) => {
      if (!event.timestamp) {
        return undefined;
      }

      return {
        timestamp: event.timestamp,
        index,
        millis: parseCursorTimestamp(event.timestamp),
      };
    })
    .filter((item): item is { timestamp: string; index: number; millis: number | undefined } => Boolean(item));

  if (parsed.length === 0) {
    return {};
  }

  const allParseable = parsed.every((item) => item.millis !== undefined);
  const ordered = [...parsed].sort((a, b) => {
    if (allParseable) {
      return (a.millis ?? 0) - (b.millis ?? 0);
    }

    return a.index - b.index;
  });

  const firstTimestamp = ordered[0]?.timestamp;
  const lastTimestamp = ordered[ordered.length - 1]?.timestamp;

  return {
    ...(firstTimestamp ? { firstTimestamp } : {}),
    ...(lastTimestamp ? { lastTimestamp } : {}),
  };
}

export function parseCursorTimestamp(timestamp: string): number | undefined {
  const match = timestamp.match(CURSOR_TIMESTAMP_RE);
  if (!match) {
    return undefined;
  }

  const [, monthName, dayText, yearText, hourText, minuteText, meridiem, offsetSign, offsetHourText, offsetMinuteText] =
    match;
  if (
    !monthName ||
    !dayText ||
    !yearText ||
    !hourText ||
    !minuteText ||
    !meridiem ||
    !offsetSign ||
    !offsetHourText ||
    !offsetMinuteText
  ) {
    return undefined;
  }

  const month = MONTHS.get(monthName.toLowerCase());
  if (month === undefined) {
    return undefined;
  }

  const day = Number(dayText);
  const year = Number(yearText);
  let hour = Number(hourText);
  const minute = Number(minuteText);
  if (meridiem.toUpperCase() === "PM" && hour !== 12) {
    hour += 12;
  }
  if (meridiem.toUpperCase() === "AM" && hour === 12) {
    hour = 0;
  }

  const offsetHours = Number(offsetHourText);
  const offsetMinutes = Number(offsetMinuteText);
  const offsetDirection = offsetSign === "+" ? 1 : -1;
  const offsetMillis = offsetDirection * (offsetHours * 60 + offsetMinutes) * 60_000;

  return Date.UTC(year, month, day, hour, minute) - offsetMillis;
}
