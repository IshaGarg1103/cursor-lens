# Cursor Lens

Cursor Lens is Isha Garg's local-first CLI for understanding coding-agent work. It reads local Cursor transcript files, computes deterministic metrics, applies privacy filtering, and writes private Markdown plus HTML reports.

The package is published as `cursor-lens`:

```bash
npx cursor-lens
```

## What It Does

- Discovers Cursor transcript workspaces from `~/.cursor/projects/*/agent-transcripts`.
- Parses parent-session JSONL transcripts, with optional subagent inclusion.
- Computes local metrics for sessions, prompts, tool calls, file references, and workflow signals.
- Excludes sensitive topics from selected examples and AI payloads.
- Redacts common secrets in displayed excerpts.
- Generates local Markdown and static HTML reports.
- Optionally creates a builder profile using a user-provided OpenAI or Anthropic API key.

## Privacy

Cursor Lens does not call an AI API by default. Local reports are generated from transcript files on your machine and written to `reports/` in the current working directory.

AI builder profiles are opt-in:

```bash
npx cursor-lens ai my-workspace --yes
```

Before any AI request, Cursor Lens prints a review of the destination, endpoint, model, workspace, selected redacted examples, masked secrets, sensitive-topic exclusions, and selected data size. Raw transcript files are never sent wholesale.

Redaction is best-effort and should not be treated as a formal security boundary.

## Usage

Run the guided flow:

```bash
npx cursor-lens
```

Generate a local report for one workspace:

```bash
npx cursor-lens my-workspace
```

Generate local reports for every discovered workspace:

```bash
npx cursor-lens all
```

Preview what would be sent for an AI builder profile:

```bash
npx cursor-lens preview my-workspace
```

Clean generated reports:

```bash
npx cursor-lens clean --yes
```

After a global install, both `cursor-lens` and `lens` are available:

```bash
npm install -g cursor-lens
lens my-workspace
```

## Configuration

Cursor Lens supports these optional environment variables:

```bash
AGENT_ANALYSIS_LLM_PROVIDER=openai
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4.1-mini
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-3-5-sonnet-latest
AGENT_ANALYSIS_MAX_OUTPUT_TOKENS=1800
```

You can provide keys through your shell environment, `.env`, `.env.local`, or the interactive prompt.

## CLI Reference

```text
cursor-lens                         Guided flow
cursor-lens <workspace>             Local report for one workspace
cursor-lens report <workspace|all>  Local report
cursor-lens ai <workspace|all>      Add your builder profile
cursor-lens preview <workspace>     Review AI payload without sending it
cursor-lens all                     Local reports for every workspace
cursor-lens clean [--yes]           Remove generated reports
cursor-lens scan                    List transcript workspaces
cursor-lens inspect --workspace <name|key|path>
cursor-lens analyze --workspace <name|key|path> [--llm] [--provider <openai|anthropic>] [--yes]
```

Useful flags:

- `--cursor-projects-dir <path>` uses a custom Cursor projects directory.
- `--include-subagents` includes transcript files under `subagents/`.
- `--out <dir>` changes the report output directory.
- `--open` opens the generated HTML report.
- `--no-open` disables automatic opening from shortcut commands.

## Project Structure

```text
src/
  analysis/    metrics, timestamps, AI synthesis payloads, LLM calls
  config/      local environment loading
  discovery/   Cursor transcript workspace discovery
  parsers/     Cursor JSONL transcript parser
  privacy/     sensitive-topic policy and redaction
  report/      Markdown and HTML report rendering
  types/       shared transcript types
test/          privacy and payload tests
```

## Maintainer Workflow

```bash
npm install
npm run check
npm run build
npm test
```

## Roadmap

- Add Claude Code transcript support.
- Add Codex CLI transcript support.
- Expand report views for comparing workspaces over time.
