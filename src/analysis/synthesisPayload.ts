import { basename } from "node:path";
import { BUILDER_ARCHETYPES, identifyBuilderArchetype } from "./archetypes.js";
import { computeProfileMetrics, selectRepresentativeUserEvents } from "./metrics.js";
import { redactText, truncateForExcerpt } from "../privacy/redact.js";
import { classifyPrivacy, summarizePrivacyDecisions, type SensitiveCategory } from "../privacy/policy.js";
import type { ProfileMetrics } from "./metrics.js";
import type { TranscriptSession, WorkspaceSummary } from "../types/transcript.js";

export type SynthesisPayload = {
  workspace: {
    displayName: string;
  };
  metrics: SynthesisMetrics;
  archetype: {
    recommended: string;
    score: number;
    evidence: string[];
    candidates: Array<{
      name: string;
      score: number;
      evidence: string[];
    }>;
    allowedProfiles: Array<{
      name: string;
      description: string;
    }>;
  };
  excerpts: Array<{
    sessionId: string;
    timestamp?: string;
    role: "user";
    text: string;
  }>;
  redactionCount: number;
  privacyExcludedCount: number;
  privacyExcludedByCategory: Record<SensitiveCategory, number>;
  estimatedChars: number;
  estimatedTokens: number;
};

type SynthesisMetrics = Omit<ProfileMetrics, "topFileRefs"> & {
  topFileRefs: Array<{ label: string; count: number }>;
};

export function buildSynthesisPayload(options: {
  workspace: WorkspaceSummary;
  sessions: TranscriptSession[];
  excerptLimit?: number;
  maxExcerptChars?: number;
}): SynthesisPayload {
  const metrics = computeProfileMetrics(options.sessions);
  const archetype = identifyBuilderArchetype(options.sessions, metrics);
  const allUserTexts = options.sessions
    .flatMap((session) => session.events)
    .filter((event) => event.role === "user")
    .map((event) => event.text);
  const privacySummary = summarizePrivacyDecisions(allUserTexts);
  const events = selectRepresentativeUserEvents(options.sessions, options.excerptLimit ?? 12).filter((event) =>
    classifyPrivacy(event.text).includeInLlmPayload,
  );
  let redactionCount = 0;

  const excerpts = events.map((event) => {
    const redacted = redactText(truncateForExcerpt(event.text, options.maxExcerptChars ?? 1_500));
    redactionCount += redacted.replacements;

    return {
      sessionId: event.sessionId,
      ...(event.timestamp ? { timestamp: event.timestamp } : {}),
      role: "user" as const,
      text: redacted.text,
    };
  });

  const payload = {
    workspace: {
      displayName: "Selected workspace",
    },
    metrics: sanitizeMetricsForAi(metrics),
    archetype: {
      recommended: archetype.name,
      score: archetype.score,
      evidence: archetype.evidence,
      candidates: archetype.candidates,
      allowedProfiles: BUILDER_ARCHETYPES.map((profile) => ({
        name: profile.name,
        description: profile.description,
      })),
    },
    excerpts,
  };
  const estimatedChars = JSON.stringify(payload).length;

  return {
    ...payload,
    redactionCount,
    privacyExcludedCount: privacySummary.excludedCount,
    privacyExcludedByCategory: privacySummary.excludedByCategory,
    estimatedChars,
    estimatedTokens: Math.ceil(estimatedChars / 4),
  };
}

export function renderSynthesisPrompt(payload: SynthesisPayload): string {
  return [
    "You are analyzing coding-agent transcript excerpts for a local, private builder-profile report.",
    "",
    "Rules:",
    "- Do not claim certainty beyond the evidence.",
    "- Ground every insight in the provided metrics or excerpts.",
    "- Write directly to the report owner in second person: use \"you\" and \"your\".",
    "- Do not say \"this builder\", \"the user\", \"they\", or \"their\" when referring to the report owner.",
    "- Make the profile feel personal, useful, and easy to skim.",
    "- Do not expose secrets. If redaction placeholders appear, treat them as private data that was removed.",
    "- Avoid copying long excerpts back verbatim.",
    "- Do not mention any specific commercial product unless it appears in the data.",
    "- Choose exactly one builder archetype from Data.archetype.allowedProfiles.",
    "- Prefer Data.archetype.recommended unless the excerpts clearly support another allowed profile.",
    "",
    "Return Markdown with exactly these sections:",
    "## Builder Archetype",
    "First line: exactly one allowed single-word archetype name from Data.archetype.allowedProfiles, with no punctuation.",
    "Then write a 2-3 sentence explanation written to \"you\".",
    "",
    "## How You Work With Agents",
    "4-6 concise bullets about your planning, steering, debugging, execution, and collaboration style.",
    "",
    "## Strengths",
    "3-5 concise bullets.",
    "",
    "## Growth Edge",
    "3-5 specific suggestions you can try in future agent sessions.",
    "",
    "## Evidence Notes",
    "Briefly cite the strongest local signals without quoting private content at length.",
    "",
    "Data:",
    JSON.stringify(payload, null, 2),
  ].join("\n");
}

function sanitizeMetricsForAi(metrics: ProfileMetrics): SynthesisMetrics {
  return {
    ...metrics,
    topFileRefs: metrics.topFileRefs.map((item) => ({
      label: sanitizePathLabel(item.path),
      count: item.count,
    })),
  };
}

function sanitizePathLabel(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const name = basename(normalized);
  if (name && name !== "." && name !== "/") {
    return name;
  }

  return "[workspace path]";
}
