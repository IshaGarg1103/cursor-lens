import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { identifyBuilderArchetype, type BuilderArchetypeResult } from "../analysis/archetypes.js";
import { computeProfileMetrics, selectRepresentativeUserEvents } from "../analysis/metrics.js";
import { summarizePrivacyDecisions } from "../privacy/policy.js";
import { redactText, truncateForExcerpt } from "../privacy/redact.js";
import type { TranscriptSession, WorkspaceSummary } from "../types/transcript.js";

export type ReportResult = {
  markdown: string;
  html: string;
  outputPath: string;
  markdownOutputPath: string;
  htmlOutputPath: string;
  redactionCount: number;
};

export type ReportMeta = {
  generatedAt: string;
  mode: string;
  provider?: string;
  model?: string;
};

type HtmlRenderOptions = {
  llmSynthesis?: string;
  reportMeta?: ReportMeta;
  profileImageSrc?: string;
};

type BuilderIdentity = {
  name: string;
  workspaceLabel: string;
  subtitle: string;
  initials: string;
  profileImageSrc?: string;
  hue: number;
  secondaryHue: number;
  focusLabel: string;
  signalLabel: string;
};

type RenderedBuilderProfile = {
  introHtml: string;
  detailsHtml: string;
};

export async function writeWorkspaceReport(options: {
  workspace: WorkspaceSummary;
  sessions: TranscriptSession[];
  outputDir: string;
  llmSynthesis?: string;
  reportMeta?: ReportMeta;
}): Promise<ReportResult> {
  await mkdir(options.outputDir, { recursive: true });
  const report = renderWorkspaceReport(options.workspace, options.sessions, {
    ...(options.llmSynthesis ? { llmSynthesis: options.llmSynthesis } : {}),
    ...(options.reportMeta ? { reportMeta: options.reportMeta } : {}),
  });
  const safeName = options.workspace.displayName.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-|-$/g, "") || "workspace";
  const stamp = Date.now();
  const markdownOutputPath = join(options.outputDir, `${safeName}-${stamp}.md`);
  const htmlOutputPath = join(options.outputDir, `${safeName}-${stamp}.html`);
  const profileImageSrc = await loadProfileImageDataUri();
  const html = renderWorkspaceHtml(options.workspace, options.sessions, {
    ...(options.llmSynthesis ? { llmSynthesis: options.llmSynthesis } : {}),
    ...(options.reportMeta ? { reportMeta: options.reportMeta } : {}),
    ...(profileImageSrc ? { profileImageSrc } : {}),
  });
  await writeFile(markdownOutputPath, report.markdown, "utf8");
  await writeFile(htmlOutputPath, html, "utf8");

  return {
    ...report,
    html,
    outputPath: markdownOutputPath,
    markdownOutputPath,
    htmlOutputPath,
  };
}

export function renderWorkspaceReport(
  workspace: WorkspaceSummary,
  sessions: TranscriptSession[],
  options: { llmSynthesis?: string; reportMeta?: ReportMeta } = {},
): { markdown: string; redactionCount: number } {
  const metrics = computeProfileMetrics(sessions);
  const aiCommand = `cursor-lens ai ${shellQuote(workspace.key)} --yes`;
  const privacySummary = summarizePrivacyDecisions(
    sessions
      .flatMap((session) => session.events)
      .filter((event) => event.role === "user")
      .map((event) => event.text),
  );
  const excerpts = selectRepresentativeUserEvents(sessions);
  let redactionCount = 0;
  const renderedExcerpts = excerpts.map((event, index) => {
    const redacted = redactText(truncateForExcerpt(event.text));
    redactionCount += redacted.replacements;
    return [
      `### Excerpt ${index + 1}`,
      `- Session: \`${event.sessionId}\``,
      event.timestamp ? `- Timestamp: ${event.timestamp}` : undefined,
      "",
      "```text",
      redacted.text,
      "```",
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");
  });

  const markdown = [
    `# Lens Profile: ${workspace.displayName}`,
    "",
    "## Privacy Summary",
    "This report was generated locally from Cursor transcript files. Raw transcripts are not uploaded by this CLI. Excerpts shown below are redacted with best-effort secret patterns.",
    "",
    `- Workspace key: \`${workspace.key}\``,
    workspace.inferredPath ? `- Inferred workspace path: \`${workspace.inferredPath}\`` : undefined,
    `- Sessions analyzed: ${metrics.sessionCount}`,
    `- Events parsed: ${metrics.eventCount}`,
    `- Masked secrets in displayed examples: ${redactionCount}`,
    `- Sensitive-topic prompts excluded from examples/AI payloads: ${privacySummary.excludedCount}`,
    options.reportMeta ? `- Generated at: ${options.reportMeta.generatedAt}` : undefined,
    options.reportMeta ? `- Mode: ${options.reportMeta.mode}` : undefined,
    options.reportMeta?.provider ? `- Provider: ${options.reportMeta.provider}` : undefined,
    options.reportMeta?.model ? `- Model: ${options.reportMeta.model}` : undefined,
    "",
    "## Local Metrics",
    `- User messages: ${metrics.userMessageCount}`,
    `- Assistant messages: ${metrics.assistantMessageCount}`,
    `- Tool calls: ${metrics.toolCallCount}`,
    `- Average user prompt length: ${metrics.averageUserPromptChars} characters`,
    `- Planning signals: ${metrics.planningSignalCount}`,
    `- Debugging signals: ${metrics.debuggingSignalCount}`,
    `- Review signals: ${metrics.reviewSignalCount}`,
    `- Redirect/correction signals: ${metrics.redirectSignalCount}`,
    metrics.firstTimestamp ? `- First timestamp seen: ${metrics.firstTimestamp}` : undefined,
    metrics.lastTimestamp ? `- Last timestamp seen: ${metrics.lastTimestamp}` : undefined,
    "",
    "## Top Tools",
    renderList(metrics.topTools.map((item) => `\`${item.name}\` (${item.count})`)),
    "",
    "## Top File References",
    renderList(metrics.topFileRefs.map((item) => `\`${displayPath(item.path)}\` (${item.count})`)),
    "",
    "## Common Three-Word Phrases",
    renderList(metrics.commonUserPhrases.map((item) => `\"${item.phrase}\" (${item.count})`)),
    "",
    "## Quick Read",
    renderStyleSnapshot(metrics),
    "",
    options.llmSynthesis ? "## Your Builder Profile" : undefined,
    options.llmSynthesis,
    options.llmSynthesis ? "" : undefined,
    "## Selected Redacted Examples",
    renderedExcerpts.length > 0 ? renderedExcerpts.join("\n\n") : "No user excerpts found.",
    "",
    "## Next Step",
    options.llmSynthesis
      ? "Next, add richer transcript adapters for Claude Code and Codex CLI."
      : `Run \`${aiCommand}\` to add your builder profile.`,
    "",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");

  return { markdown, redactionCount };
}

export function renderWorkspaceHtml(
  workspace: WorkspaceSummary,
  sessions: TranscriptSession[],
  options: HtmlRenderOptions = {},
): string {
  const metrics = computeProfileMetrics(sessions);
  const privacySummary = summarizePrivacyDecisions(
    sessions
      .flatMap((session) => session.events)
      .filter((event) => event.role === "user")
      .map((event) => event.text),
  );
  const excerpts = selectRepresentativeUserEvents(sessions);
  let redactionCount = 0;
  const redactedExcerpts = excerpts.map((event, index) => {
    const redacted = redactText(truncateForExcerpt(event.text));
    redactionCount += redacted.replacements;

    return {
      index: index + 1,
      sessionId: event.sessionId,
      timestamp: event.timestamp,
      text: redacted.text,
    };
  });
  const styleSnapshot = renderStyleSnapshot(metrics);
  const aiCommand = `cursor-lens ai ${shellQuote(workspace.key)} --yes`;
  const builderArchetype = identifyBuilderArchetype(sessions, metrics);
  const builderIdentity = buildBuilderIdentity(workspace, metrics, builderArchetype, options.profileImageSrc);
  const builderProfile = options.llmSynthesis ? renderBuilderProfile(options.llmSynthesis) : undefined;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Lens: ${escapeHtml(workspace.displayName)}</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #080808;
      --panel: #101010;
      --panel-soft: #151515;
      --text: #f2f0ea;
      --muted: #a4a19a;
      --line: #292929;
      --accent: #e8e4d8;
      --accent-soft: #1d1d1b;
      --good: #9dbea7;
      --warn: #d3b36a;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background:
        radial-gradient(circle at 16% 0%, rgba(79, 185, 255, 0.12), transparent 28rem),
        radial-gradient(circle at 76% 3%, rgba(236, 182, 255, 0.1), transparent 30rem),
        var(--bg);
      color: var(--text);
      line-height: 1.62;
    }
    main {
      width: min(1040px, calc(100vw - 40px));
      margin: 0 auto;
      padding: 56px 0 80px;
    }
    header {
      margin-bottom: 34px;
    }
    .eyebrow {
      color: var(--muted);
      font-weight: 650;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      font-size: 0.72rem;
    }
    h1 {
      max-width: 960px;
      margin: 18px 0 10px;
      font-size: clamp(2.4rem, 6vw, 4.4rem);
      line-height: 0.92;
      letter-spacing: -0.07em;
      overflow-wrap: anywhere;
    }
    h2 {
      margin: 0 0 14px;
      font-size: 1.15rem;
      letter-spacing: -0.02em;
    }
    h3 {
      margin: 18px 0 8px;
      font-size: 1rem;
      letter-spacing: -0.01em;
    }
    p { margin: 0 0 12px; }
    .muted { color: var(--muted); }
    .grid {
      display: grid;
      grid-template-columns: repeat(12, 1fr);
      gap: 22px;
      margin-bottom: 22px;
    }
    .card {
      grid-column: span 12;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 22px;
      box-shadow: none;
    }
    .profile-card {
      background: var(--bg);
      padding: clamp(24px, 4vw, 38px);
    }
    .profile-layout {
      align-items: start;
    }
    .profile-card > .eyebrow {
      margin-bottom: 8px;
    }
    .profile-card > h2 {
      font-size: clamp(1.55rem, 2.6vw, 2.05rem);
      line-height: 1.05;
      margin-bottom: 24px;
      letter-spacing: -0.055em;
    }
    .prose {
      max-width: 820px;
      font-size: 0.93rem;
    }
    .prose h2 {
      margin: 28px 0 10px;
      padding-top: 22px;
      border-top: 1px solid var(--line);
      font-size: 0.98rem;
    }
    .prose h2:first-child {
      margin-top: 0;
      padding-top: 0;
      border-top: 0;
    }
    .prose h3 {
      color: var(--text);
      font-size: 1rem;
    }
    .prose p,
    .prose li {
      color: color-mix(in srgb, var(--text) 88%, var(--muted));
    }
    .prose strong {
      color: var(--text);
      font-weight: 800;
    }
    .prose ul {
      display: grid;
      gap: 8px;
      padding-left: 0;
      list-style: none;
    }
    .prose li {
      position: relative;
      padding-left: 22px;
    }
    .prose li::before {
      content: "›";
      position: absolute;
      left: 0;
      top: 0;
      color: var(--muted);
      font-size: 1.05rem;
    }
    .builder-id-card {
      position: relative;
      overflow: hidden;
      align-self: start;
      justify-self: end;
      width: min(100%, 260px);
      min-height: 0;
      padding: 18px;
      border-color: var(--line);
      border-radius: 16px;
      background: var(--bg);
    }
    .builder-id-card::before {
      content: none;
      position: absolute;
      inset: 14px;
      border: 1px solid var(--line);
      border-radius: 14px;
      pointer-events: none;
    }
    .id-inner {
      position: relative;
      padding: 0;
      border-radius: 0;
      color: var(--text);
    }
    .id-topline {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      color: var(--muted);
      font-size: 0.68rem;
      font-weight: 650;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    .id-mark {
      display: none;
    }
    .builder-avatar {
      position: relative;
      display: grid;
      place-items: center;
      width: 96px;
      aspect-ratio: 1;
      margin: 28px auto 18px;
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,0.18);
      background: var(--bg);
      box-shadow: none;
      isolation: isolate;
      overflow: hidden;
    }
    .builder-avatar::before,
    .builder-avatar::after { content: none; }
    .builder-avatar::before {
      width: 62%;
      height: 62%;
      border: 1px solid rgba(255,255,255,0.72);
      border-radius: 999px;
    }
    .builder-avatar::after {
      width: 44%;
      height: 16%;
      left: 28%;
      bottom: 22%;
      border: 1px solid rgba(255,255,255,0.52);
      border-radius: 999px;
    }
    .builder-avatar span {
      color: var(--text);
      font-size: 1.6rem;
      font-weight: 750;
      letter-spacing: -0.06em;
      text-shadow: none;
    }
    .builder-avatar img {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: cover;
      border-radius: inherit;
    }
    .id-name {
      margin: 0;
      text-align: center;
      font-size: 1.35rem;
      line-height: 0.96;
      letter-spacing: -0.055em;
    }
    .id-subtitle {
      max-width: 22ch;
      margin: 7px auto 14px;
      color: var(--muted);
      text-align: center;
      font-size: 0.82rem;
    }
    .id-stat-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin-top: 14px;
    }
    .id-stat {
      border: 1px solid rgba(16, 24, 40, 0.1);
      border-color: var(--line);
      border-radius: 9px;
      padding: 8px;
      background: transparent;
    }
    .id-stat strong {
      display: block;
      font-size: 0.82rem;
      line-height: 1;
      letter-spacing: -0.04em;
    }
    .id-stat span {
      display: block;
      margin-top: 5px;
      color: var(--muted);
      font-size: 0.64rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      font-weight: 750;
    }
    .id-footer {
      display: none;
    }
    .id-barcode {
      display: none;
    }
    .id-barcode i {
      display: block;
      width: 3px;
      height: var(--bar-height);
      border-radius: 999px;
      background: color-mix(in srgb, var(--muted) 76%, transparent);
    }
    .span-4 { grid-column: span 4; }
    .span-6 { grid-column: span 6; }
    .span-8 { grid-column: span 8; }
    .metric {
      font-size: 1.65rem;
      font-weight: 720;
      letter-spacing: -0.04em;
      margin-top: 6px;
    }
    .label {
      color: var(--muted);
      font-size: 0.72rem;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      font-weight: 650;
    }
    ul {
      margin: 0;
      padding-left: 20px;
    }
    li + li { margin-top: 6px; }
    code, pre {
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
    }
    code {
      background: var(--panel-soft);
      border: 1px solid var(--line);
      border-radius: 5px;
      padding: 1px 5px;
      overflow-wrap: anywhere;
    }
    details {
      background: var(--panel-soft);
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 14px 16px;
    }
    details + details { margin-top: 10px; }
    summary {
      cursor: pointer;
      font-weight: 750;
    }
    pre {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 14px;
      max-height: 420px;
      overflow: auto;
    }
    .pill-row {
      display: flex;
      flex-wrap: wrap;
      gap: 7px;
      margin-top: 18px;
    }
    .pill {
      display: inline-flex;
      gap: 6px;
      align-items: center;
      border: 1px solid var(--line);
      background: transparent;
      border-radius: 999px;
      padding: 5px 9px;
      color: var(--muted);
      font-size: 0.82rem;
    }
    .privacy {
      border-color: var(--line);
    }
    .warning {
      border-color: var(--line);
      background: var(--panel);
    }
    .summary-card {
      background: var(--panel);
    }
    @media (max-width: 820px) {
      main { width: min(100vw - 20px, 1120px); padding: 28px 0; }
      .span-4, .span-6, .span-8 { grid-column: span 12; }
      .metric { font-size: 1.7rem; }
      .builder-avatar { max-width: 180px; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div class="eyebrow">Lens Profile</div>
      <h1>${escapeHtml(workspace.displayName)}</h1>
      <p class="muted">A local profile of how this workspace uses coding agents. Raw transcripts are not uploaded.</p>
      <div class="pill-row">
        <span class="pill privacy">Sessions: ${metrics.sessionCount}</span>
        <span class="pill privacy">Events: ${metrics.eventCount}</span>
        <span class="pill privacy">Masked secrets: ${redactionCount}</span>
        <span class="pill privacy">Sensitive excluded: ${privacySummary.excludedCount}</span>
        ${options.reportMeta ? `<span class="pill privacy">${escapeHtml(options.reportMeta.mode)}</span>` : ""}
        ${options.reportMeta?.provider ? `<span class="pill privacy">${escapeHtml(options.reportMeta.provider)} · ${escapeHtml(options.reportMeta.model ?? "default model")}</span>` : ""}
      </div>
    </header>

    ${
      builderProfile
        ? `<section class="grid profile-layout"><div class="card profile-card span-8"><div class="eyebrow">Curated Insight</div><h2>Your Builder Profile</h2><div class="prose">${builderProfile.introHtml}</div></div>${renderBuilderIdCard(builderIdentity)}</section>${builderProfile.detailsHtml ? `<section class="grid"><div class="card profile-card"><div class="prose">${builderProfile.detailsHtml}</div></div></section>` : ""}`
        : `<section class="grid"><div class="card warning"><h2>Local Report</h2><p>This report uses local metrics only. Run <code>${escapeHtml(aiCommand)}</code> to add your builder profile.</p></div></section>`
    }

    <section class="grid">
      <div class="card span-8 summary-card">
        <div class="eyebrow">Read This First</div>
        <h2>Quick Read</h2>
        <p>${escapeHtml(styleSnapshot)}</p>
      </div>
      <div class="card span-4">
        <h2>Timeline</h2>
        <p><span class="label">First seen</span><br>${escapeHtml(metrics.firstTimestamp ?? "Unknown")}</p>
        <p><span class="label">Last seen</span><br>${escapeHtml(metrics.lastTimestamp ?? "Unknown")}</p>
      </div>
    </section>

    <section class="grid">
      ${metricCard("Your Requests", metrics.userMessageCount)}
      ${metricCard("Agent Replies", metrics.assistantMessageCount)}
      ${metricCard("Tool Calls", metrics.toolCallCount)}
      ${metricCard("Avg Request Length", metrics.averageUserPromptChars)}
      ${metricCard("Planning Moments", metrics.planningSignalCount)}
      ${metricCard("Corrections", metrics.redirectSignalCount)}
    </section>

    <section class="grid">
      <div class="card span-4">
        <h2>Top Tools</h2>
        ${htmlList(metrics.topTools.map((item) => `${item.name} (${item.count})`))}
      </div>
      <div class="card span-4">
        <h2>Prompt Patterns</h2>
        ${htmlList(metrics.commonUserPhrases.map((item) => `${item.phrase} (${item.count})`))}
      </div>
      <div class="card span-4">
        <h2>Privacy Notes</h2>
        <ul>
          <li>Reports are written locally.</li>
          <li>This project template ignores generated reports by default.</li>
          <li>Sensitive-topic prompts are excluded from examples and AI payloads.</li>
          <li>Redaction is best-effort, not a formal security guarantee.</li>
          <li>Treat generated reports as private files if you move them elsewhere.</li>
        </ul>
      </div>
    </section>

    <section class="grid">
      <div class="card">
        <h2>Raw Local File Signals</h2>
        ${htmlList(metrics.topFileRefs.map((item) => `${displayPath(item.path)} (${item.count})`))}
      </div>
    </section>

    ${
      options.reportMeta
        ? `<section class="grid"><div class="card"><h2>Report Details</h2><div class="pill-row"><span class="pill">Generated: ${escapeHtml(options.reportMeta.generatedAt)}</span><span class="pill">Mode: ${escapeHtml(options.reportMeta.mode)}</span>${options.reportMeta.provider ? `<span class="pill">Provider: ${escapeHtml(options.reportMeta.provider)}</span>` : ""}${options.reportMeta.model ? `<span class="pill">Model: ${escapeHtml(options.reportMeta.model)}</span>` : ""}</div></div></section>`
        : ""
    }

    <section class="grid">
      <div class="card">
        <h2>Selected Redacted Examples</h2>
        ${
          redactedExcerpts.length === 0
            ? "<p class=\"muted\">No selected examples found.</p>"
            : redactedExcerpts
                .map(
                  (excerpt) => `<details>
            <summary>Excerpt ${excerpt.index} · ${escapeHtml(excerpt.sessionId)}${excerpt.timestamp ? ` · ${escapeHtml(excerpt.timestamp)}` : ""}</summary>
            <pre>${escapeHtml(excerpt.text)}</pre>
          </details>`,
                )
                .join("\n")
        }
      </div>
    </section>
  </main>
</body>
</html>
`;
}

function renderList(items: string[]): string {
  if (items.length === 0) {
    return "- None found";
  }

  return items.map((item) => `- ${item}`).join("\n");
}

function metricCard(label: string, value: string | number): string {
  return `<div class="card span-4"><div class="label">${escapeHtml(label)}</div><div class="metric">${escapeHtml(String(value))}</div></div>`;
}

function htmlList(items: string[]): string {
  if (items.length === 0) {
    return "<p class=\"muted\">None found</p>";
  }

  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function renderBuilderProfile(input: string): RenderedBuilderProfile {
  const normalized = personalizeProfileCopy(input);
  const splitMatch = normalized.match(/\n## How You Work With Agents\b/i);
  if (!splitMatch || splitMatch.index === undefined) {
    return {
      introHtml: markdownishToHtml(normalized),
      detailsHtml: "",
    };
  }

  const intro = normalized.slice(0, splitMatch.index).trim();
  const details = normalized.slice(splitMatch.index + 1).trim();

  return {
    introHtml: markdownishToHtml(intro),
    detailsHtml: markdownishToHtml(details),
  };
}

function renderBuilderIdCard(identity: BuilderIdentity): string {
  return `<aside class="card span-4 builder-id-card" style="--avatar-hue: ${identity.hue}; --avatar-hue-2: ${identity.secondaryHue};">
    <div class="id-inner">
      <div class="id-topline"><span>Builder ID</span><span>${escapeHtml(identity.workspaceLabel)}</span></div>
      <div class="builder-avatar" role="img" aria-label="${escapeHtml(identity.name)} builder avatar">
        ${
          identity.profileImageSrc
            ? `<img src="${escapeHtml(identity.profileImageSrc)}" alt="">`
            : `<span>${escapeHtml(identity.initials)}</span>`
        }
      </div>
      <h2 class="id-name">${escapeHtml(identity.name)}</h2>
      <p class="id-subtitle">${escapeHtml(identity.subtitle)}</p>
      <div class="id-stat-grid">
        <div class="id-stat"><strong>${escapeHtml(identity.focusLabel)}</strong><span>Primary Signal</span></div>
        <div class="id-stat"><strong>${escapeHtml(identity.signalLabel)}</strong><span>Agent Style</span></div>
      </div>
    </div>
  </aside>`;
}

function buildBuilderIdentity(
  workspace: WorkspaceSummary,
  metrics: ReturnType<typeof computeProfileMetrics>,
  archetype: BuilderArchetypeResult,
  profileImageSrc: string | undefined,
): BuilderIdentity {
  return {
    name: archetype.name,
    workspaceLabel: compactWorkspaceLabel(workspace),
    subtitle: archetype.tagline,
    initials: archetype.logo,
    ...(profileImageSrc ? { profileImageSrc } : {}),
    hue: archetype.hue,
    secondaryHue: archetype.secondaryHue,
    focusLabel: archetype.signalLabel,
    signalLabel: agentStyleLabel(metrics, archetype),
  };
}

function compactWorkspaceLabel(workspace: WorkspaceSummary): string {
  const label = workspace.displayName || workspace.key;
  const usersPrefixMatch = label.match(/^Users-[^-]+-(.+)$/);
  return usersPrefixMatch?.[1] ?? label;
}

async function loadProfileImageDataUri(): Promise<string | undefined> {
  const candidates = [
    resolve(process.cwd(), "assets/image.png"),
    new URL("../../../assets/image.png", import.meta.url),
  ];

  for (const candidate of candidates) {
    try {
      const image = await readFile(candidate);
      return `data:image/png;base64,${image.toString("base64")}`;
    } catch {
      // Optional package asset. Fall back to initials if unavailable.
    }
  }

  return undefined;
}

function agentStyleLabel(metrics: ReturnType<typeof computeProfileMetrics>, archetype: BuilderArchetypeResult): string {
  if (archetype.score >= 18) {
    return "High Signal";
  }
  if (metrics.redirectSignalCount > 0) {
    return "Hands-on";
  }
  if (metrics.planningSignalCount > metrics.debuggingSignalCount) {
    return "Strategic";
  }
  if (metrics.debuggingSignalCount > 0) {
    return "Iterative";
  }
  if (metrics.reviewSignalCount > 0) {
    return "Reflective";
  }

  return "Emerging";
}

function markdownishToHtml(input: string): string {
  const lines = personalizeProfileCopy(input).split(/\r?\n/);
  const html: string[] = [];
  let listOpen = false;

  for (const line of lines) {
    if (line.startsWith("## ")) {
      if (listOpen) {
        html.push("</ul>");
        listOpen = false;
      }
      html.push(`<h2>${renderInlineMarkdown(line.slice(3))}</h2>`);
      continue;
    }

    if (line.startsWith("### ")) {
      if (listOpen) {
        html.push("</ul>");
        listOpen = false;
      }
      html.push(`<h3>${renderInlineMarkdown(line.slice(4))}</h3>`);
      continue;
    }

    if (line.startsWith("- ")) {
      if (!listOpen) {
        html.push("<ul>");
        listOpen = true;
      }
      html.push(`<li>${renderInlineMarkdown(line.slice(2))}</li>`);
      continue;
    }

    if (listOpen) {
      html.push("</ul>");
      listOpen = false;
    }

    if (line.trim()) {
      html.push(`<p>${renderInlineMarkdown(line)}</p>`);
    }
  }

  if (listOpen) {
    html.push("</ul>");
  }

  return html.join("\n");
}

function renderInlineMarkdown(input: string): string {
  return escapeHtml(input)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function personalizeProfileCopy(input: string): string {
  return input
    .replace(/\bThis builder appears\b/g, "You appear")
    .replace(/\bThis builder\b/g, "You")
    .replace(/\bthis builder\b/g, "you")
    .replace(/\bThe user\b/g, "You")
    .replace(/\bthe user\b/g, "you")
    .replace(/\bThey\b/g, "You")
    .replace(/\bthey\b/g, "you")
    .replace(/\bTheir\b/g, "Your")
    .replace(/\btheir\b/g, "your")
    .replace(/\bHow They Work With Agents\b/g, "How You Work With Agents");
}

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function shellQuote(input: string): string {
  if (/^[A-Za-z0-9_./:@-]+$/.test(input)) {
    return input;
  }

  return `'${input.replaceAll("'", "'\\''")}'`;
}

function displayPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, "~");
}

function renderStyleSnapshot(metrics: ReturnType<typeof computeProfileMetrics>): string {
  const signals = [
    metrics.planningSignalCount > 0 ? "plan or ask about approach before some work" : undefined,
    metrics.debuggingSignalCount > 0 ? "use agents for debugging and fixing loops" : undefined,
    metrics.reviewSignalCount > 0 ? "ask for review and behavior checks" : undefined,
    metrics.redirectSignalCount > 0 ? "actively redirect or correct the agent" : undefined,
  ].filter((item): item is string => Boolean(item));

  if (signals.length === 0) {
    return "Not enough signal yet to summarize working style.";
  }

  return `Based on deterministic local signals, you ${signals.join(", ")}. Your builder profile can make this more nuanced once you opt in.`;
}
