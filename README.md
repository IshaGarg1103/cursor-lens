# Cursor Lens

Cursor Lens is a local-first CLI for understanding how you work with coding agents. It reads Cursor transcript files from your machine, computes workflow metrics, applies privacy filtering, and generates private Markdown plus HTML reports.

Use it with `npx`:

```bash
npx cursor-lens
```

## Highlights

- Finds Cursor transcript workspaces automatically.
- Generates local reports with sessions, prompts, tool calls, file references, and workflow signals.
- Adds an optional AI builder profile and archetype when you provide your own API key.
- Keeps raw transcript files local and excludes sensitive topics from selected examples.
- Writes reports to `./reports`.

## Privacy

Cursor Lens does not call an AI API by default. AI profiles are opt-in, and before any request the CLI shows what will be sent: provider, model, workspace, selected redacted examples, masked secrets, sensitive-topic exclusions, and payload size.

Raw transcript files are never sent wholesale. Redaction is best-effort and should not be treated as a formal security boundary.

## Usage

Start the guided flow:

```bash
npx cursor-lens
```

Generate a local report for one workspace:

```bash
npx cursor-lens my-workspace
```

Add an AI builder profile:

```bash
npx cursor-lens ai my-workspace --yes
```

Analyze all workspaces:

```bash
npx cursor-lens all
```

Clean generated reports:

```bash
npx cursor-lens clean --yes
```

## Configuration

Optional environment variables:

```bash
AGENT_ANALYSIS_LLM_PROVIDER=openai
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4.1-mini
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-3-5-sonnet-latest
AGENT_ANALYSIS_MAX_OUTPUT_TOKENS=1800
```

Keys can be provided through your shell environment, `.env`, `.env.local`, or the interactive prompt.

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

## Development

```bash
npm install
npm run check
npm run build
npm test
```

## Roadmap

- Add Claude Code transcript support.
- Add Codex CLI transcript support.
