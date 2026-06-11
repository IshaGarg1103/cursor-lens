export type LlmProvider = "openai" | "anthropic";

export type LlmConfig = {
  provider: LlmProvider;
  model: string;
  apiKey: string;
  baseUrl?: string;
  maxOutputTokens: number;
};

export type LlmPreviewConfig = Omit<LlmConfig, "apiKey" | "baseUrl">;

export async function synthesizeWithLlm(config: LlmConfig, prompt: string): Promise<string> {
  switch (config.provider) {
    case "openai":
      return synthesizeWithOpenAI(config, prompt);
    case "anthropic":
      return synthesizeWithAnthropic(config, prompt);
  }
}

export function resolveLlmConfig(options: {
  provider?: string;
  model?: string;
  maxOutputTokens?: number;
}): LlmConfig {
  const preview = resolveLlmPreviewConfig(options);
  const provider = preview.provider;
  const apiKey = provider === "openai" ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const envName = provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
    throw new Error(`Missing ${envName}. Add it to your shell environment or local .env file.`);
  }

  const baseUrl = provider === "openai" ? process.env.OPENAI_BASE_URL : process.env.ANTHROPIC_BASE_URL;

  return {
    ...preview,
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
  };
}

export function resolveLlmPreviewConfig(options: {
  provider?: string;
  model?: string;
  maxOutputTokens?: number;
}): LlmPreviewConfig {
  const provider = normalizeProvider(options.provider ?? process.env.AGENT_ANALYSIS_LLM_PROVIDER ?? "openai");

  return {
    provider,
    model: options.model ?? defaultModelForProvider(provider),
    maxOutputTokens: options.maxOutputTokens ?? Number(process.env.AGENT_ANALYSIS_MAX_OUTPUT_TOKENS ?? 1_800),
  };
}

function normalizeProvider(provider: string): LlmProvider {
  const normalized = provider.toLowerCase();
  if (normalized === "openai" || normalized === "anthropic") {
    return normalized;
  }

  throw new Error(`Unsupported LLM provider "${provider}". Use "openai" or "anthropic".`);
}

function defaultModelForProvider(provider: LlmProvider): string {
  if (provider === "openai") {
    return process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
  }

  return process.env.ANTHROPIC_MODEL ?? "claude-3-5-sonnet-latest";
}

async function synthesizeWithOpenAI(config: LlmConfig, prompt: string): Promise<string> {
  const response = await fetch(`${config.baseUrl ?? "https://api.openai.com/v1"}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      input: [
        {
          role: "user",
          content: prompt,
        },
      ],
      max_output_tokens: config.maxOutputTokens,
    }),
  });

  const json = (await response.json().catch(() => ({}))) as OpenAIResponse & ApiErrorResponse;
  if (!response.ok) {
    throw new Error(`OpenAI request failed (${response.status}): ${extractApiError(json)}`);
  }

  if ("output_text" in json && typeof json.output_text === "string" && json.output_text.trim()) {
    return json.output_text.trim();
  }

  const text = json.output
    ?.flatMap((item: OpenAIOutputItem) => item.content ?? [])
    .map((content: OpenAIContentItem) => content.text)
    .filter((value): value is string => Boolean(value))
    .join("\n")
    .trim();
  if (!text) {
    throw new Error("OpenAI response did not contain text output.");
  }

  return text;
}

async function synthesizeWithAnthropic(config: LlmConfig, prompt: string): Promise<string> {
  const response = await fetch(`${config.baseUrl ?? "https://api.anthropic.com/v1"}/messages`, {
    method: "POST",
    headers: {
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: config.maxOutputTokens,
      system:
        "You write concise, evidence-grounded builder profiles from coding-agent transcript metrics and redacted excerpts.",
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    }),
  });

  const json = (await response.json().catch(() => ({}))) as AnthropicResponse & ApiErrorResponse;
  if (!response.ok) {
    throw new Error(`Anthropic request failed (${response.status}): ${extractApiError(json)}`);
  }

  const text = json.content
    ?.map((content: AnthropicContentItem) => ("text" in content ? content.text : undefined))
    .filter((value): value is string => Boolean(value))
    .join("\n")
    .trim();
  if (!text) {
    throw new Error("Anthropic response did not contain text output.");
  }

  return text;
}

function extractApiError(json: ApiErrorResponse | Record<string, unknown>): string {
  const maybeError = json.error;
  if (typeof maybeError === "object" && maybeError && "message" in maybeError) {
    return String(maybeError.message);
  }

  return JSON.stringify(json);
}

type ApiErrorResponse = {
  error?: {
    message?: string;
  };
};

type OpenAIResponse = {
  output_text?: string;
  output?: OpenAIOutputItem[];
};

type OpenAIOutputItem = {
  content?: OpenAIContentItem[];
};

type OpenAIContentItem = {
  text?: string;
};

type AnthropicResponse = {
  content?: AnthropicContentItem[];
};

type AnthropicContentItem =
  | {
      type: "text";
      text: string;
    }
  | Record<string, unknown>;
