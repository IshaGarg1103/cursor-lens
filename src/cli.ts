#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { basename, relative } from "node:path";
import { createInterface } from "node:readline/promises";
import { resolveLlmConfig, resolveLlmPreviewConfig, synthesizeWithLlm } from "./analysis/llm.js";
import { buildSynthesisPayload, renderSynthesisPrompt } from "./analysis/synthesisPayload.js";
import { loadLocalEnv } from "./config/env.js";
import { scanCursorTranscripts } from "./discovery/cursor.js";
import { writeWorkspaceReport } from "./report/render.js";
import type { ScanResult, TranscriptSession, WorkspaceSummary } from "./types/transcript.js";

type Args = {
  command: string;
  positionals: string[];
  flags: Map<string, string | boolean>;
};

type LlmChoice = {
  provider: "openai" | "anthropic";
  model?: string;
};

type LlmReviewSummary = {
  workspace: WorkspaceSummary;
  sessions: TranscriptSession[];
  promptCount: number;
  redactionCount: number;
  privacyExcludedCount: number;
  estimatedChars: number;
  estimatedTokens: number;
};

async function main(): Promise<void> {
  loadLocalEnv();
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case "":
    case "run":
      await runWizardCommand(args);
      return;
    case "report":
      await shortcutWorkspaceCommand(args, { local: true, open: true });
      return;
    case "ai":
      await shortcutWorkspaceCommand(args, { ai: true, open: true });
      return;
    case "all":
      await executeWorkspaceTarget(args, {
        target: "all",
        local: true,
        ai: false,
        reviewOnly: false,
        open: !args.flags.get("no-open"),
      });
      return;
    case "workspace":
      await shortcutWorkspaceCommand(args, { local: true, open: true });
      return;
    case "local":
      await shortcutWorkspaceCommand(args, { local: true });
      return;
    case "preview":
      await shortcutWorkspaceCommand(args, { ai: true, reviewOnly: true });
      return;
    case "open":
      await shortcutWorkspaceCommand(args, { open: true });
      return;
    case "clean":
      await cleanReportsCommand(args);
      return;
    case "scan":
      await scanCommand(args);
      return;
    case "inspect":
      await inspectCommand(args);
      return;
    case "analyze":
      await analyzeCommand(args);
      return;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    default:
      await executeWorkspaceTarget(args, {
        target: args.command,
        local: true,
        ai: false,
        reviewOnly: false,
        open: !args.flags.get("no-open"),
      });
  }
}

async function shortcutWorkspaceCommand(
  args: Args,
  options: { local?: boolean; ai?: boolean; reviewOnly?: boolean; open?: boolean },
): Promise<void> {
  const target = args.positionals[0];
  if (!target) {
    throw new Error(`Missing workspace name. Try: cursor-lens ${args.command} my-workspace`);
  }

  await executeWorkspaceTarget(args, {
    target,
    local: Boolean(options.local),
    ai: Boolean(options.ai),
    reviewOnly: Boolean(options.reviewOnly),
    open: Boolean(options.open) && !args.flags.get("no-open"),
  });
}

async function executeWorkspaceTarget(
  args: Args,
  options: {
    target: string;
    local: boolean;
    ai: boolean;
    reviewOnly: boolean;
    open: boolean;
  },
): Promise<void> {
  const result = await runScan(args);
  const selectedWorkspaces =
    options.target === "all"
      ? result.workspaces
      : (() => {
          const workspace = selectWorkspace(result, options.target);
          if (!workspace) {
            printScanResult(result);
            throw new Error(`No matching workspace found for "${options.target}".`);
          }
          return [workspace];
        })();

  if (selectedWorkspaces.length === 0) {
    console.log("No workspaces found.");
    return;
  }

  const outputDir = resolve(getStringFlag(args, "out") ?? "reports");
  const reports: Array<{ workspace: WorkspaceSummary; htmlOutputPath: string }> = [];

  for (const workspace of selectedWorkspaces) {
    const sessions = sessionsForWorkspace(result.sessions, workspace.key);
    console.log(`Preparing ${workspace.displayName}...`);
    const llmSynthesis = options.ai
      ? await maybeRunAiSynthesis(args, {
          workspace,
          sessions,
          reviewOnly: options.reviewOnly,
        })
      : undefined;

    if (options.reviewOnly) {
      continue;
    }

    const provider = getStringFlag(args, "provider") ?? inferDefaultProvider();
    const model = getStringFlag(args, "model");
    const report = await writeWorkspaceReport({
      workspace,
      sessions,
      outputDir,
      ...(llmSynthesis ? { llmSynthesis } : {}),
      reportMeta: {
        generatedAt: new Date().toISOString(),
        mode: llmSynthesis ? "Builder profile" : "Local report",
        ...(llmSynthesis && provider ? { provider } : {}),
        ...(llmSynthesis && model ? { model } : {}),
      },
    });
    reports.push({ workspace, htmlOutputPath: report.htmlOutputPath });
    console.log(`HTML report written: ${report.htmlOutputPath}`);
  }

  if (options.reviewOnly) {
    return;
  }

  const finalHtmlPath =
    reports.length === 1
      ? reports[0]?.htmlOutputPath
      : await writeIndexReport({
          outputDir,
          reports,
        });

  if (finalHtmlPath && options.open) {
    await openFile(finalHtmlPath);
    console.log(`Opened report: ${finalHtmlPath}`);
  } else if (finalHtmlPath) {
    console.log(`Report ready: ${finalHtmlPath}`);
  }
}

async function maybeRunAiSynthesis(
  args: Args,
  options: {
    workspace: WorkspaceSummary;
    sessions: TranscriptSession[];
    reviewOnly: boolean;
  },
): Promise<string | undefined> {
  const provider = await resolveAiProviderForCommand(args);
  if (!provider) {
    console.log("Generating a local report without your builder profile.");
    return undefined;
  }

  const payload = buildSynthesisPayload({
    workspace: options.workspace,
    sessions: options.sessions,
    excerptLimit: getNumberFlag(args, "excerpt-limit") ?? 12,
    maxExcerptChars: getNumberFlag(args, "max-excerpt-chars") ?? 1_500,
  });
  const model = getStringFlag(args, "model");
  const maxOutputTokens = getNumberFlag(args, "max-output-tokens");
  const llmOptions = {
    provider,
    ...(model ? { model } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
  };
  const previewConfig = resolveLlmPreviewConfig(llmOptions);
  printLlmPreflight({
    provider: previewConfig.provider,
    model: previewConfig.model,
    endpoint: aiEndpointForProvider(previewConfig.provider),
    workspace: options.workspace,
    sessionCount: options.sessions.length,
    excerptCount: payload.excerpts.length,
    redactionCount: payload.redactionCount,
    privacyExcludedCount: payload.privacyExcludedCount,
    estimatedChars: payload.estimatedChars,
    estimatedTokens: payload.estimatedTokens,
  });

  if (options.reviewOnly) {
    console.log("\nReview only. No AI request was sent.");
    return undefined;
  }

  if (!args.flags.get("yes") && !args.flags.get("auto")) {
    console.log("\nNo AI request was sent. Add --yes after reviewing what will be sent.");
    return undefined;
  }

  console.log("\nSending selected redacted examples to AI provider...");
  const config = resolveLlmConfig(llmOptions);
  return synthesizeWithLlm(config, renderSynthesisPrompt(payload));
}

async function cleanReportsCommand(args: Args): Promise<void> {
  const outputDir = resolve(getStringFlag(args, "out") ?? "reports");
  const entries = await readdir(outputDir, { withFileTypes: true }).catch(() => []);
  const targets = entries
    .filter((entry) => entry.isFile() && isLensReportFile(entry.name))
    .map((entry) => resolve(outputDir, entry.name));

  if (targets.length === 0) {
    console.log(`No generated reports found in ${outputDir}.`);
    return;
  }

  if (!args.flags.get("yes")) {
    console.log(`Would remove ${targets.length} report files from ${outputDir}.`);
    for (const target of targets.slice(0, 10)) {
      console.log(`- ${basename(target)}`);
    }
    if (targets.length > 10) {
      console.log(`- ...and ${targets.length - 10} more`);
    }
    console.log("Rerun with --yes to delete them.");
    return;
  }

  await Promise.all(targets.map((target) => rm(target)));
  console.log(`Removed ${targets.length} report files from ${outputDir}.`);
}

function isLensReportFile(filename: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*-\d{13}\.(?:html|md)$/i.test(filename) || /^index-\d{13}\.html$/i.test(filename);
}

async function runWizardCommand(args: Args): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log("Lens");
    console.log("Local-first builder profile generator for Cursor transcripts.\n");

    const result = await runScan(args);
    if (result.workspaces.length === 0) {
      console.log("No Cursor transcript workspaces found.");
      console.log("Expected location: ~/.cursor/projects/*/agent-transcripts");
      return;
    }

    const selectedWorkspaces = selectWizardWorkspaces(args, result) ?? (await promptForWorkspaces(rl, result.workspaces));
    const outputDir = resolve(getStringFlag(args, "out") ?? "reports");
    const openReport = !args.flags.get("no-open") && (await askYesNo(rl, "Open the HTML report when done?", true));
    const llmChoice = args.flags.get("no-llm") ? undefined : await promptForLlmChoice(rl, args);
    const confirmedAllAi =
      llmChoice && selectedWorkspaces.length > 1
        ? await confirmAiForAllWorkspaces(rl, {
            workspaces: selectedWorkspaces,
            sessions: result.sessions,
            llmChoice,
          })
        : undefined;
    const reports: Array<{ workspace: WorkspaceSummary; htmlOutputPath: string }> = [];

    for (const workspace of selectedWorkspaces) {
      console.log(`\nPreparing ${workspace.displayName}...`);
      const sessions = sessionsForWorkspace(result.sessions, workspace.key);
      const llmSynthesis = llmChoice
        ? await runConfirmedLlmSynthesis(rl, {
            workspace,
            sessions,
            provider: llmChoice.provider,
            ...(llmChoice.model ? { model: llmChoice.model } : {}),
            skipConfirmation: confirmedAllAi === true,
            skipReview: selectedWorkspaces.length > 1,
          })
        : undefined;

      const report = await writeWorkspaceReport({
        workspace,
        sessions,
        outputDir,
        ...(llmSynthesis ? { llmSynthesis } : {}),
        reportMeta: {
          generatedAt: new Date().toISOString(),
          mode: llmSynthesis ? "Builder profile" : "Local report",
          ...(llmChoice ? { provider: llmChoice.provider, model: llmChoice.model } : {}),
        },
      });
      reports.push({ workspace, htmlOutputPath: report.htmlOutputPath });
      console.log(`Markdown report written: ${report.markdownOutputPath}`);
      console.log(`HTML report written: ${report.htmlOutputPath}`);
    }

    const finalHtmlPath =
      reports.length === 1
        ? reports[0]?.htmlOutputPath
        : await writeIndexReport({
            outputDir,
            reports,
          });

    if (finalHtmlPath && openReport) {
      await openFile(finalHtmlPath);
      console.log(`Opened report: ${finalHtmlPath}`);
    } else if (finalHtmlPath) {
      console.log(`\nReport ready: ${finalHtmlPath}`);
    }
  } finally {
    rl.close();
  }
}

function selectWizardWorkspaces(args: Args, result: ScanResult): WorkspaceSummary[] | undefined {
  if (args.flags.get("all")) {
    return result.workspaces;
  }

  const selector = getStringFlag(args, "workspace");
  if (!selector) {
    return undefined;
  }

  const workspace = selectWorkspace(result, selector);
  if (!workspace) {
    printScanResult(result);
    throw new Error(`No matching workspace found for "${selector}".`);
  }

  return [workspace];
}

async function scanCommand(args: Args): Promise<void> {
  const result = await runScan(args);
  printScanResult(result);
}

async function inspectCommand(args: Args): Promise<void> {
  const result = await runScan(args);
  const workspace = selectWorkspace(result, getStringFlag(args, "workspace"));
  if (!workspace) {
    printScanResult(result);
    console.error("\nNo matching workspace found. Pass --workspace <name|key|path>.");
    process.exitCode = 1;
    return;
  }

  const sessions = sessionsForWorkspace(result.sessions, workspace.key);
  console.log(`Workspace: ${workspace.displayName}`);
  console.log(`Key: ${workspace.key}`);
  if (workspace.inferredPath) {
    console.log(`Inferred path: ${workspace.inferredPath}`);
  }
  console.log(`Transcript root: ${workspace.transcriptRoot}`);
  console.log(`Sessions: ${sessions.length}`);
  console.log(`Events: ${workspace.eventCount}`);
  console.log(`User messages: ${workspace.userMessageCount}`);
  console.log(`Assistant messages: ${workspace.assistantMessageCount}`);
  console.log(`Tool calls: ${workspace.toolCallCount}`);
  console.log(`Parse errors: ${sessions.reduce((sum, session) => sum + session.parseErrors.length, 0)}`);
  console.log("\nSessions:");
  for (const session of sessions) {
    console.log(`- ${session.id}: ${session.events.length} events (${session.sourcePath})`);
  }
}

async function analyzeCommand(args: Args): Promise<void> {
  const result = await runScan(args);
  const workspace = selectWorkspace(result, getStringFlag(args, "workspace"));
  if (!workspace) {
    printScanResult(result);
    console.error("\nNo matching workspace found. Pass --workspace <name|key|path>.");
    process.exitCode = 1;
    return;
  }

  const sessions = sessionsForWorkspace(result.sessions, workspace.key);
  const outputDir = resolve(getStringFlag(args, "out") ?? "reports");
  const llmSynthesis = await maybeRunLlmSynthesis(args, workspace, sessions);
  if (args.flags.get("llm") && !llmSynthesis) {
    return;
  }

  const provider = getStringFlag(args, "provider");
  const model = getStringFlag(args, "model");
  const report = await writeWorkspaceReport({
    workspace,
    sessions,
    outputDir,
    ...(llmSynthesis ? { llmSynthesis } : {}),
    reportMeta: {
      generatedAt: new Date().toISOString(),
      mode: llmSynthesis ? "Builder profile" : "Local report",
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
    },
  });
  console.log(`Markdown report written: ${report.markdownOutputPath}`);
  console.log(`HTML report written: ${report.htmlOutputPath}`);
  console.log(`Masked secrets in selected examples: ${report.redactionCount}`);
  if (args.flags.get("open")) {
    await openFile(report.htmlOutputPath);
    console.log(`Opened report: ${report.htmlOutputPath}`);
  }
}

async function maybeRunLlmSynthesis(
  args: Args,
  workspace: WorkspaceSummary,
  sessions: TranscriptSession[],
): Promise<string | undefined> {
  if (!args.flags.get("llm")) {
    return undefined;
  }

  const payload = buildSynthesisPayload({
    workspace,
    sessions,
    excerptLimit: getNumberFlag(args, "excerpt-limit") ?? 12,
    maxExcerptChars: getNumberFlag(args, "max-excerpt-chars") ?? 1_500,
  });
  const provider = getStringFlag(args, "provider");
  const model = getStringFlag(args, "model");
  const maxOutputTokens = getNumberFlag(args, "max-output-tokens");
  const llmOptions = {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
  };
  const previewConfig = resolveLlmPreviewConfig(llmOptions);

  printLlmPreflight({
    provider: previewConfig.provider,
    model: previewConfig.model,
    endpoint: aiEndpointForProvider(previewConfig.provider),
    workspace,
    sessionCount: sessions.length,
    excerptCount: payload.excerpts.length,
    redactionCount: payload.redactionCount,
    privacyExcludedCount: payload.privacyExcludedCount,
    estimatedChars: payload.estimatedChars,
    estimatedTokens: payload.estimatedTokens,
  });

  if (!args.flags.get("yes")) {
    console.log("\nNo AI request was sent. Rerun with `--yes` after reviewing what will be sent.");
    return undefined;
  }

  console.log("\nSending selected redacted examples to AI provider...");
  const config = resolveLlmConfig(llmOptions);
  return synthesizeWithLlm(config, renderSynthesisPrompt(payload));
}

async function runScan(args: Args): Promise<ScanResult> {
  const cursorProjectsDir = getStringFlag(args, "cursor-projects-dir");
  return scanCursorTranscripts({
    ...(cursorProjectsDir ? { cursorProjectsDir } : {}),
    includeSubagents: Boolean(args.flags.get("include-subagents")),
  });
}

function printScanResult(result: ScanResult): void {
  console.log("Scanned transcript roots:");
  if (result.scannedRoots.length === 0) {
    console.log("- None found");
  } else {
    for (const root of result.scannedRoots) {
      console.log(`- ${root}`);
    }
  }

  console.log("\nWorkspaces:");
  if (result.workspaces.length === 0) {
    console.log("- None found");
  } else {
    for (const workspace of result.workspaces) {
      const path = workspace.inferredPath ? ` | ${workspace.inferredPath}` : "";
      console.log(
        `- ${workspace.displayName} | sessions=${workspace.sessionCount} events=${workspace.eventCount} key=${workspace.key}${path}`,
      );
    }
  }

  if (result.errors.length > 0) {
    console.log("\nErrors:");
    for (const error of result.errors) {
      console.log(`- ${error}`);
    }
  }
}

function selectWorkspace(result: ScanResult, selector: string | undefined): WorkspaceSummary | undefined {
  if (!selector && result.workspaces.length === 1) {
    return result.workspaces[0];
  }

  if (!selector) {
    return undefined;
  }

  const normalizedSelector = normalize(selector);
  return result.workspaces.find((workspace) => {
    return (
      normalize(workspace.key) === normalizedSelector ||
      normalize(workspace.displayName) === normalizedSelector ||
      normalize(workspace.inferredPath ?? "") === normalizedSelector ||
      normalize(workspace.inferredPath ?? "").endsWith(normalizedSelector)
    );
  });
}

function sessionsForWorkspace(sessions: TranscriptSession[], workspaceKey: string): TranscriptSession[] {
  return sessions.filter((session) => session.workspaceKey === workspaceKey);
}

function parseArgs(rawArgs: string[]): Args {
  const [command = "", ...rest] = rawArgs;
  const flags = new Map<string, string | boolean>();
  const positionals: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token?.startsWith("--")) {
      if (token) {
        positionals.push(token);
      }
      continue;
    }

    const key = token.slice(2);
    const next = rest[index + 1];
    if (next && !next.startsWith("--")) {
      flags.set(key, next);
      index += 1;
    } else {
      flags.set(key, true);
    }
  }

  return { command, positionals, flags };
}

function getStringFlag(args: Args, key: string): string | undefined {
  const value = args.flags.get(key);
  return typeof value === "string" ? value : undefined;
}

function getNumberFlag(args: Args, key: string): number | undefined {
  const value = getStringFlag(args, key);
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`--${key} must be a positive number.`);
  }

  return parsed;
}

function inferDefaultProvider(): "openai" | "anthropic" | undefined {
  if (process.env.OPENAI_API_KEY) {
    return "openai";
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return "anthropic";
  }

  return undefined;
}

async function resolveAiProviderForCommand(args: Args): Promise<"openai" | "anthropic" | undefined> {
  const providerFromFlag = getStringFlag(args, "provider");
  const configuredProvider = inferDefaultProvider();
  const requestedProvider = normalizeProviderInput(providerFromFlag);

  if (requestedProvider && hasApiKeyForProvider(requestedProvider)) {
    return requestedProvider;
  }

  if (!requestedProvider && configuredProvider) {
    return configuredProvider;
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const provider = requestedProvider ?? (await askForProvider(rl, configuredProvider ?? "openai"));
    if (hasApiKeyForProvider(provider)) {
      return provider;
    }

    const envName = envNameForProvider(provider);
    console.log(`\nNo ${envName} found.`);
    console.log(`Paste an ${displayProvider(provider)} API key for this run, or press Enter to skip AI.`);
    const key = await askSecret(rl, `${envName}: `);
    if (!key) {
      console.log("No API key entered.");
      return undefined;
    }

    process.env[envName] = key;
    return provider;
  } finally {
    rl.close();
  }
}

function hasApiKeyForProvider(provider: "openai" | "anthropic"): boolean {
  return Boolean(process.env[envNameForProvider(provider)]);
}

function envNameForProvider(provider: "openai" | "anthropic"): "OPENAI_API_KEY" | "ANTHROPIC_API_KEY" {
  return provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
}

function displayProvider(provider: "openai" | "anthropic"): string {
  return provider === "openai" ? "OpenAI" : "Anthropic";
}

function aiEndpointForProvider(provider: "openai" | "anthropic"): string {
  if (provider === "openai") {
    return process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  }

  return process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com/v1";
}

function normalizeProviderInput(provider: string | undefined): "openai" | "anthropic" | undefined {
  if (!provider) {
    return undefined;
  }

  const normalized = provider.toLowerCase();
  if (normalized === "openai" || normalized === "anthropic") {
    return normalized;
  }

  throw new Error(`Unsupported provider "${provider}". Use "openai" or "anthropic".`);
}

async function askForProvider(
  rl: ReturnType<typeof createInterface>,
  defaultProvider: "openai" | "anthropic",
): Promise<"openai" | "anthropic"> {
  while (true) {
    const provider = (await ask(rl, "Provider: openai or anthropic", defaultProvider)).toLowerCase();
    if (provider === "openai" || provider === "anthropic") {
      return provider;
    }
    console.log("Please enter openai or anthropic.");
  }
}

function printLlmPreflight(options: {
  provider: string;
  model: string;
  endpoint: string;
  workspace: WorkspaceSummary;
  sessionCount: number;
  excerptCount: number;
  redactionCount: number;
  privacyExcludedCount: number;
  estimatedChars: number;
  estimatedTokens: number;
}): void {
  console.log("Review before sending to AI:");
  console.log(`- Destination: ${options.provider}`);
  console.log(`- Endpoint: ${options.endpoint}`);
  console.log(`- Model: ${options.model}`);
  console.log(`- Workspace: ${options.workspace.displayName}`);
  console.log(`- Sessions included: ${options.sessionCount}`);
  console.log(`- Selected redacted examples: ${options.excerptCount}`);
  console.log(`- Masked secrets: ${options.redactionCount}`);
  console.log(`- Sensitive-topic prompts excluded: ${options.privacyExcludedCount}`);
  console.log(`- Selected data size: ${options.estimatedChars} chars (~${options.estimatedTokens} tokens)`);
  console.log("- Raw transcript files are never sent wholesale.");
  console.log("- This size is only the selected metrics and redacted examples sent for this AI profile.");
}

async function confirmAiForAllWorkspaces(
  rl: ReturnType<typeof createInterface>,
  options: {
    workspaces: WorkspaceSummary[];
    sessions: TranscriptSession[];
    llmChoice: LlmChoice;
  },
): Promise<boolean> {
  const llmOptions = {
    provider: options.llmChoice.provider,
    ...(options.llmChoice.model ? { model: options.llmChoice.model } : {}),
  };
  const previewConfig = resolveLlmPreviewConfig(llmOptions);
  const summaries = options.workspaces.map((workspace) => {
    const sessions = sessionsForWorkspace(options.sessions, workspace.key);
    const payload = buildSynthesisPayload({
      workspace,
      sessions,
      excerptLimit: 12,
      maxExcerptChars: 1_500,
    });

    return {
      workspace,
      sessions,
      promptCount: payload.excerpts.length,
      redactionCount: payload.redactionCount,
      privacyExcludedCount: payload.privacyExcludedCount,
      estimatedChars: payload.estimatedChars,
      estimatedTokens: payload.estimatedTokens,
    };
  });
  const totals = summaries.reduce(
    (sum, item) => ({
      promptCount: sum.promptCount + item.promptCount,
      redactionCount: sum.redactionCount + item.redactionCount,
      privacyExcludedCount: sum.privacyExcludedCount + item.privacyExcludedCount,
      estimatedChars: sum.estimatedChars + item.estimatedChars,
      estimatedTokens: sum.estimatedTokens + item.estimatedTokens,
    }),
    {
      promptCount: 0,
      redactionCount: 0,
      privacyExcludedCount: 0,
      estimatedChars: 0,
      estimatedTokens: 0,
    },
  );

  console.log("\nReview before sending all workspace profiles to AI:");
  console.log(`- Destination: ${previewConfig.provider}`);
  console.log(`- Endpoint: ${aiEndpointForProvider(previewConfig.provider)}`);
  console.log(`- Model: ${previewConfig.model}`);
  console.log(`- Workspaces: ${summaries.length}`);
  console.log(`- Selected redacted examples: ${totals.promptCount}`);
  console.log(`- Masked secrets: ${totals.redactionCount}`);
  console.log(`- Sensitive-topic prompts excluded: ${totals.privacyExcludedCount}`);
  console.log(`- Total selected data size: ${totals.estimatedChars} chars (~${totals.estimatedTokens} tokens)`);
  console.log("- Lens sends one separate selected-data request per workspace.");
  console.log("- Raw transcript files are never sent wholesale.");
  console.log("\nWorkspace breakdown:");
  for (const summary of summaries) {
    printWorkspaceAiSummary(summary);
  }

  return askYesNo(rl, "Send selected redacted examples for all listed workspaces?", false);
}

function printWorkspaceAiSummary(summary: LlmReviewSummary): void {
  console.log(
    `- ${summary.workspace.displayName}: ${summary.promptCount} examples, ${summary.estimatedChars} chars (~${summary.estimatedTokens} tokens), ${summary.privacyExcludedCount} sensitive-topic prompts excluded`,
  );
}

async function runConfirmedLlmSynthesis(
  rl: ReturnType<typeof createInterface>,
  options: {
    workspace: WorkspaceSummary;
    sessions: TranscriptSession[];
    provider: string;
    model?: string;
    skipConfirmation?: boolean;
    skipReview?: boolean;
  },
): Promise<string | undefined> {
  const payload = buildSynthesisPayload({
    workspace: options.workspace,
    sessions: options.sessions,
    excerptLimit: 12,
    maxExcerptChars: 1_500,
  });
  const llmOptions = {
    provider: options.provider,
    ...(options.model ? { model: options.model } : {}),
  };
  const previewConfig = resolveLlmPreviewConfig(llmOptions);
  if (!options.skipReview) {
    printLlmPreflight({
      provider: previewConfig.provider,
      model: previewConfig.model,
      endpoint: aiEndpointForProvider(previewConfig.provider),
      workspace: options.workspace,
      sessionCount: options.sessions.length,
      excerptCount: payload.excerpts.length,
      redactionCount: payload.redactionCount,
      privacyExcludedCount: payload.privacyExcludedCount,
      estimatedChars: payload.estimatedChars,
      estimatedTokens: payload.estimatedTokens,
    });

    const confirmed = options.skipConfirmation
      ? true
      : await askYesNo(rl, "Send these selected redacted examples to the AI provider?", false);
    if (!confirmed) {
      console.log("Skipping builder profile for this workspace.");
      return undefined;
    }
  } else if (!options.skipConfirmation) {
    console.log("Skipping builder profile for this workspace.");
    return undefined;
  }

  console.log("Sending selected redacted examples...");
  const config = resolveLlmConfig(llmOptions);
  return synthesizeWithLlm(config, renderSynthesisPrompt(payload));
}

async function promptForWorkspaces(
  rl: ReturnType<typeof createInterface>,
  workspaces: WorkspaceSummary[],
): Promise<WorkspaceSummary[]> {
  if (workspaces.length === 1) {
    const workspace = workspaces[0];
    if (!workspace) {
      return [];
    }

    console.log(`Found one workspace: ${workspace.displayName}`);
    return [workspace];
  }

  console.log("Found Cursor workspaces:");
  console.log("0. All workspaces");
  workspaces.forEach((workspace, index) => {
    const path = workspace.inferredPath ? ` | ${workspace.inferredPath}` : "";
    console.log(
      `${index + 1}. ${workspace.displayName} | sessions=${workspace.sessionCount} events=${workspace.eventCount}${path}`,
    );
  });

  while (true) {
    const answer = await ask(rl, "\nChoose a workspace number", "1");
    const selected = Number(answer);
    if (selected === 0) {
      return workspaces;
    }

    const workspace = workspaces[selected - 1];
    if (Number.isInteger(selected) && workspace) {
      return [workspace];
    }

    console.log("Please enter a valid workspace number.");
  }
}

async function promptForLlmChoice(
  rl: ReturnType<typeof createInterface>,
  args: Args,
): Promise<{ provider: "openai" | "anthropic"; model?: string } | undefined> {
  const useLlm = args.flags.get("llm") ? true : await askYesNo(rl, "Add your builder profile?", false);
  if (!useLlm) {
    return undefined;
  }

  const requestedProvider = normalizeProviderInput(getStringFlag(args, "provider"));
  const defaultProvider = requestedProvider ?? inferDefaultProvider() ?? "openai";
  while (true) {
    const provider = requestedProvider ?? (await askForProvider(rl, defaultProvider));
    if (!hasApiKeyForProvider(provider)) {
      const envName = envNameForProvider(provider);
      console.log(`\nNo ${envName} found.`);
      console.log(`Paste an ${displayProvider(provider)} API key for this run, or press Enter to skip AI.`);
      const key = await askSecret(rl, `${envName}: `);
      if (!key) {
        console.log("No API key entered.");
        return undefined;
      }
      process.env[envName] = key;
    }

    const preview = resolveLlmPreviewConfig({ provider });
    const model = getStringFlag(args, "model") ?? (await ask(rl, "Model", preview.model));
    return {
      provider,
      ...(model ? { model } : {}),
    };
  }
}

async function ask(rl: ReturnType<typeof createInterface>, prompt: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue ? ` (${defaultValue})` : "";
  const answer = await rl.question(`${prompt}${suffix}: `);
  return answer.trim() || defaultValue || "";
}

async function askSecret(rl: ReturnType<typeof createInterface>, prompt: string): Promise<string> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    return ask(rl, prompt);
  }

  rl.pause();
  process.stdout.write(prompt);

  return new Promise<string>((resolvePromise, reject) => {
    const input = process.stdin;
    const wasRaw = input.isRaw;
    let value = "";

    const cleanup = (): void => {
      input.off("data", onData);
      input.setRawMode(wasRaw);
      rl.resume();
    };

    const finish = (): void => {
      cleanup();
      process.stdout.write("\n");
      resolvePromise(value.trim());
    };

    const onData = (chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      for (const char of text) {
        if (char === "\u0003") {
          cleanup();
          process.stdout.write("\n");
          reject(new Error("Aborted with Ctrl+C"));
          return;
        }
        if (char === "\r" || char === "\n") {
          finish();
          return;
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };

    try {
      input.setRawMode(true);
      input.resume();
      input.on("data", onData);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

async function askYesNo(
  rl: ReturnType<typeof createInterface>,
  prompt: string,
  defaultValue: boolean,
): Promise<boolean> {
  const suffix = defaultValue ? "Y/n" : "y/N";
  while (true) {
    const answer = (await rl.question(`${prompt} (${suffix}): `)).trim().toLowerCase();
    if (!answer) {
      return defaultValue;
    }
    if (answer === "y" || answer === "yes") {
      return true;
    }
    if (answer === "n" || answer === "no") {
      return false;
    }
    console.log("Please answer y or n.");
  }
}

async function openFile(path: string): Promise<void> {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args =
    process.platform === "win32"
      ? ["/c", "start", "", path]
      : [path];

  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", reject);
    child.on("spawn", () => {
      child.unref();
      resolvePromise();
    });
  });
}

async function writeIndexReport(options: {
  outputDir: string;
  reports: Array<{ workspace: WorkspaceSummary; htmlOutputPath: string }>;
}): Promise<string> {
  await mkdir(options.outputDir, { recursive: true });
  const outputPath = resolve(options.outputDir, `index-${Date.now()}.html`);
  const links = options.reports
    .map((report) => {
      const href = relative(options.outputDir, report.htmlOutputPath);
      return `<a class="card" href="${escapeHtml(href)}">
        <strong>${escapeHtml(report.workspace.displayName)}</strong>
        <span>${report.workspace.sessionCount} sessions · ${report.workspace.eventCount} events · ${report.workspace.userMessageCount} user messages</span>
      </a>`;
    })
    .join("\n");
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Lens Reports</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; padding: 48px 20px; background: Canvas; color: CanvasText; }
    main { max-width: 980px; margin: 0 auto; }
    h1 { font-size: clamp(2rem, 6vw, 4rem); letter-spacing: -0.06em; line-height: 0.95; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; margin-top: 28px; }
    .card { display: block; color: inherit; text-decoration: none; border: 1px solid color-mix(in srgb, CanvasText 16%, transparent); border-radius: 18px; padding: 18px; background: color-mix(in srgb, Canvas 92%, CanvasText 8%); }
    .card:hover { border-color: LinkText; }
    strong { display: block; font-size: 1.05rem; margin-bottom: 8px; }
    span { opacity: 0.72; }
  </style>
</head>
<body>
  <main>
    <h1>Lens Reports</h1>
    <p>Generated locally. Choose a workspace report:</p>
    <div class="grid">${links}</div>
  </main>
</body>
</html>
`;
  await writeFile(outputPath, html, "utf8");
  return outputPath;
}

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function printHelp(): void {
  console.log(`cursor-lens

Usage:
  cursor-lens                         Guided flow
  cursor-lens <workspace>             Local report for one workspace
  cursor-lens report <workspace|all>  Local report
  cursor-lens ai <workspace|all>      Add your builder profile
  cursor-lens preview <workspace>     Review AI payload without sending it
  cursor-lens all                     Local reports for every workspace
  cursor-lens clean [--yes]

Advanced:
  cursor-lens run [--workspace <name|key|path>] [--all] [--no-llm] [--no-open]
  cursor-lens scan [--cursor-projects-dir <path>] [--include-subagents]
  cursor-lens inspect --workspace <name|key|path>
  cursor-lens analyze --workspace <name|key|path> [--out <dir>] [--open]
  cursor-lens analyze --workspace <name|key|path> --llm --provider <openai|anthropic> --yes

Examples:
  npx cursor-lens
  npx cursor-lens my-workspace
  npx cursor-lens report my-workspace
  npx cursor-lens ai my-workspace --yes
  npx cursor-lens all
  npx cursor-lens clean

Privacy:
  The current implementation reads local Cursor transcript JSONL files and writes local Markdown and HTML reports.
  AI calls are explicit. Lens shows the endpoint and selected redacted examples before sending.
`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
