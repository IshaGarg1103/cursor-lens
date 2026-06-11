import { classifyPrivacy } from "../privacy/policy.js";
import type { ProfileMetrics } from "./metrics.js";
import type { TranscriptSession } from "../types/transcript.js";

export type BuilderArchetypeName =
  | "Architect"
  | "Debugger"
  | "Reviewer"
  | "Researcher"
  | "Builder"
  | "Refiner"
  | "Director"
  | "Explorer"
  | "Operator"
  | "Learner";

export type BuilderArchetype = {
  name: BuilderArchetypeName;
  logo: string;
  tagline: string;
  signalLabel: string;
  hue: number;
  secondaryHue: number;
  description: string;
};

export type BuilderArchetypeResult = BuilderArchetype & {
  score: number;
  evidence: string[];
  candidates: Array<{
    name: BuilderArchetypeName;
    score: number;
    evidence: string[];
  }>;
};

type ArchetypeDefinition = BuilderArchetype & {
  patterns: RegExp[];
  metricScore: (metrics: ProfileMetrics) => number;
};

const ARCHETYPE_DEFINITIONS: ArchetypeDefinition[] = [
  {
    name: "Architect",
    logo: "AR",
    tagline: "Designs before building",
    signalLabel: "System Shape",
    hue: 238,
    secondaryHue: 274,
    description: "Plans structure, architecture, tradeoffs, boundaries, and long-term code shape before implementation.",
    patterns: [
      /\b(architecture|architect|design|system design|structure|schema|abstraction|trade-?off|approach|plan)\b/i,
      /\b(how should|what approach|before implementing|scope|module boundary|data model)\b/i,
    ],
    metricScore: (metrics) => metrics.planningSignalCount * 4 + Math.round(metrics.averageUserPromptChars / 500),
  },
  {
    name: "Debugger",
    logo: "DB",
    tagline: "Turns failures into fixes",
    signalLabel: "Fix Loop",
    hue: 0,
    secondaryHue: 26,
    description: "Uses agents for errors, failing tests, stack traces, regressions, logs, and repair loops.",
    patterns: [
      /\b(error|bug|debug|failing|failed|failure|fix|issue|stack trace|exception|regression|broken)\b/i,
      /\b(lint|test failed|not working|crash|reproduce|diagnose)\b/i,
    ],
    metricScore: (metrics) => metrics.debuggingSignalCount * 4,
  },
  {
    name: "Reviewer",
    logo: "RV",
    tagline: "Checks behavior and risk",
    signalLabel: "Review",
    hue: 196,
    secondaryHue: 218,
    description: "Asks for audits, critique, correctness checks, security review, and PR-style feedback.",
    patterns: [
      /\b(review|feedback|audit|check|look over|security review|bugbot|critique|risk|regression)\b/i,
      /\b(any issues|is this safe|does this look|missing tests|code review)\b/i,
    ],
    metricScore: (metrics) => metrics.reviewSignalCount * 5,
  },
  {
    name: "Researcher",
    logo: "RS",
    tagline: "Investigates deeply",
    signalLabel: "Research",
    hue: 142,
    secondaryHue: 174,
    description: "Uses agents to understand papers, models, experiments, algorithms, libraries, and unfamiliar domains.",
    patterns: [
      /\b(research|paper|experiment|model|training|dataset|benchmark|algorithm|pytorch|neural|study)\b/i,
      /\b(compare|evaluate|why does|implementation detail|methodology)\b/i,
    ],
    metricScore: (metrics) => Math.min(metrics.averageUserPromptChars, 1_200) / 160,
  },
  {
    name: "Builder",
    logo: "BD",
    tagline: "Ships working product",
    signalLabel: "Feature Work",
    hue: 32,
    secondaryHue: 54,
    description: "Focuses on implementing features, workflows, UI, CLIs, integrations, and end-to-end product behavior.",
    patterns: [
      /\b(build|implement|create|add|make|feature|workflow|integration|ui|cli|screen|button|form)\b/i,
      /\b(end-to-end|ship|working|product|functionality|user-facing)\b/i,
    ],
    metricScore: (metrics) => Math.min(metrics.toolCallCount / 10, 8) + Math.min(metrics.userMessageCount / 8, 6),
  },
  {
    name: "Refiner",
    logo: "RF",
    tagline: "Polishes the rough edges",
    signalLabel: "Polish",
    hue: 318,
    secondaryHue: 348,
    description: "Iterates on naming, layout, copy, cleanup, simplification, accuracy, and product feel.",
    patterns: [
      /\b(polish|refine|cleanup|clean up|simplify|rename|wording|copy|layout|nice|sloppy|accurate)\b/i,
      /\b(make it better|improve|structured|presentation|design touch|less redundant)\b/i,
    ],
    metricScore: (metrics) => Math.max(metrics.redirectSignalCount, 0) * 2 + metrics.reviewSignalCount,
  },
  {
    name: "Director",
    logo: "DR",
    tagline: "Steers the session",
    signalLabel: "Direction",
    hue: 262,
    secondaryHue: 304,
    description: "Actively redirects the agent with constraints, corrections, course changes, and clear preferences.",
    patterns: [
      /\b(no|stop|instead|actually|don't|do not|wrong|not that|change|keep it|remove|use this)\b/i,
      /\b(make sure|as i said|accordingly|not mine|not what i asked|follow this)\b/i,
    ],
    metricScore: (metrics) => metrics.redirectSignalCount * 5,
  },
  {
    name: "Explorer",
    logo: "EX",
    tagline: "Maps unknown systems",
    signalLabel: "Discovery",
    hue: 210,
    secondaryHue: 164,
    description: "Starts broad, asks for repo summaries, folder maps, system discovery, and unfamiliar codebase orientation.",
    patterns: [
      /\b(summarize|explore|inspect|map|overview|structure|folder|repo|codebase|where is|find)\b/i,
      /\b(what are|how is this organized|walk me through|understand the project)\b/i,
    ],
    metricScore: (metrics) => Math.min(metrics.topFileRefs.length, 10) + Math.min(metrics.sessionCount, 6),
  },
  {
    name: "Operator",
    logo: "OP",
    tagline: "Runs the machinery",
    signalLabel: "Execution",
    hue: 88,
    secondaryHue: 112,
    description: "Uses agents for commands, package publishing, setup, CI, deployment, environment config, and release work.",
    patterns: [
      /\b(npm|npx|publish|package|registry|install|build|deploy|ci|terminal|command|script|release)\b/i,
      /\b(env|config|login|2fa|otp|version|dry-run|prepack)\b/i,
    ],
    metricScore: (metrics) => Math.min(metrics.toolCallCount / 6, 10),
  },
  {
    name: "Learner",
    logo: "LR",
    tagline: "Learns by asking",
    signalLabel: "Learning",
    hue: 46,
    secondaryHue: 186,
    description: "Asks for explanations, step-by-step understanding, conceptual breakdowns, and why/how reasoning.",
    patterns: [
      /\b(explain|teach|learn|understand|why|how does|what is|step by step|break down|walkthrough)\b/i,
      /\b(can you explain|help me understand|what does this mean)\b/i,
    ],
    metricScore: (metrics) => Math.min(metrics.averageUserPromptChars / 220, 6),
  },
];

const DEFAULT_ARCHETYPE = ARCHETYPE_DEFINITIONS.find((definition) => definition.name === "Builder") as ArchetypeDefinition;

export const BUILDER_ARCHETYPES: BuilderArchetype[] = ARCHETYPE_DEFINITIONS.map(
  ({ patterns: _patterns, metricScore: _metricScore, ...archetype }) => archetype,
);

export function identifyBuilderArchetype(sessions: TranscriptSession[], metrics: ProfileMetrics): BuilderArchetypeResult {
  const userTexts = sessions
    .flatMap((session) => session.events)
    .filter((event) => event.role === "user" && classifyPrivacy(event.text).includeInLocalReport)
    .map((event) => event.text);

  const scored = ARCHETYPE_DEFINITIONS.map((definition) => {
    const evidence = matchingEvidence(userTexts, definition.patterns);
    const score = definition.metricScore(metrics) + evidence.length * 3;
    return {
      ...definition,
      score,
      evidence,
    };
  }).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  const winner = scored[0] ?? {
    ...DEFAULT_ARCHETYPE,
    score: 0,
    evidence: [],
  };

  return {
    name: winner.name,
    logo: winner.logo,
    tagline: winner.tagline,
    signalLabel: winner.signalLabel,
    hue: winner.hue,
    secondaryHue: winner.secondaryHue,
    description: winner.description,
    score: Math.round(winner.score * 10) / 10,
    evidence: winner.evidence,
    candidates: scored.slice(0, 3).map((item) => ({
      name: item.name,
      score: Math.round(item.score * 10) / 10,
      evidence: item.evidence,
    })),
  };
}

function matchingEvidence(texts: string[], patterns: RegExp[]): string[] {
  const evidence: string[] = [];
  for (const text of texts) {
    for (const pattern of patterns) {
      const match = text.match(pattern)?.[0];
      if (match) {
        evidence.push(match.toLowerCase());
        break;
      }
    }
    if (evidence.length >= 4) {
      break;
    }
  }

  return [...new Set(evidence)];
}
