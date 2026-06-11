const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(sk-[A-Za-z0-9_-]{20,})\b/g, "[REDACTED_OPENAI_KEY]"],
  [/\b(sk-ant-[A-Za-z0-9_-]{20,})\b/g, "[REDACTED_ANTHROPIC_KEY]"],
  [/\b(xox[baprs]-[A-Za-z0-9-]{20,})\b/g, "[REDACTED_SLACK_TOKEN]"],
  [/\b(gh[pousr]_[A-Za-z0-9_]{20,})\b/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED_AWS_ACCESS_KEY]"],
  [/\bnpm_[A-Za-z0-9]{30,}\b/g, "[REDACTED_NPM_TOKEN]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/g, "Bearer [REDACTED_TOKEN]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED_JWT]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]"],
  [/\b([A-Za-z0-9_]*API[A-Za-z0-9_]*_?KEY)\s*=\s*['"]?[^'"\s]+/gi, "$1=[REDACTED]"],
  [/\b([A-Za-z0-9_]*TOKEN)\s*=\s*['"]?[^'"\s]+/gi, "$1=[REDACTED]"],
  [/\b([A-Za-z0-9_]*SECRET)\s*=\s*['"]?[^'"\s]+/gi, "$1=[REDACTED]"],
  [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]"],
  [/\b(?:\d[ -]*?){13,19}\b/g, "[REDACTED_POSSIBLE_CARD]"],
];

export type RedactionResult = {
  text: string;
  replacements: number;
};

export function redactText(input: string): RedactionResult {
  let text = input;
  let replacements = 0;

  for (const [pattern, replacement] of SECRET_PATTERNS) {
    text = text.replace(pattern, () => {
      replacements += 1;
      return replacement;
    });
  }

  return { text, replacements };
}

export function truncateForExcerpt(input: string, maxChars = 1_200): string {
  if (input.length <= maxChars) {
    return input;
  }

  return `${input.slice(0, maxChars).trimEnd()}\n[TRUNCATED]`;
}
