export type SensitiveCategory =
  | "secret"
  | "financeTrading"
  | "personalIdentity"
  | "applicationAdmissions"
  | "medicalLegal"
  | "privateCredential"
  | "privateFile";

export type PrivacyDecision = {
  includeInLocalReport: boolean;
  includeInLlmPayload: boolean;
  categories: SensitiveCategory[];
  reason?: string;
};

const CATEGORY_PATTERNS: Record<SensitiveCategory, RegExp[]> = {
  secret: [
    /\b(sk-[A-Za-z0-9_-]{20,})\b/i,
    /\b(sk-ant-[A-Za-z0-9_-]{20,})\b/i,
    /\b(gh[pousr]_[A-Za-z0-9_]{20,})\b/i,
    /\b(AKIA|ASIA)[A-Z0-9]{16}\b/i,
    /\bnpm_[A-Za-z0-9]{30,}\b/i,
    /\b(xox[baprs]-[A-Za-z0-9-]{20,})\b/i,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/i,
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/i,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
    /\b(api[_-]?key|secret|token|password|passwd|private[_-]?key)\b/i,
    /\bOPENAI_API_KEY\b|\bANTHROPIC_API_KEY\b/i,
  ],
  financeTrading: [
    /\b(stock|stocks|trading|trade|trader|ibkr|interactive brokers|polygon|alpaca|finnhub|market cap|float|vwap|premarket|after-hours|small caps?|ticker|sec filing|offering risk|short interest)\b/i,
  ],
  personalIdentity: [
    /\b(passport|ssn|social security|aadhaar|pan card|driver'?s license|date of birth|dob|home address|phone number)\b/i,
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  ],
  applicationAdmissions: [
    /\b(startup school|yc application|application essay|visa|immigration|resume|cv|cover letter|admissions?)\b/i,
  ],
  medicalLegal: [
    /\b(doctor|medical|diagnosis|prescription|therapy|lawyer|attorney|lawsuit|legal advice|contract dispute)\b/i,
  ],
  privateCredential: [
    /\b(login|logout|session cookie|jwt|oauth|credential|auth token|bearer token)\b/i,
  ],
  privateFile: [
    /\.env\b/i,
    /\bcredentials\.json\b/i,
    /\bid_rsa\b|\bid_ed25519\b/i,
    /\/Users\/[^/\s]+\/\.(?:ssh|aws|config|cursor)\b/i,
  ],
};

export function classifyPrivacy(text: string): PrivacyDecision {
  const categories = Object.entries(CATEGORY_PATTERNS)
    .filter(([, patterns]) => patterns.some((pattern) => pattern.test(text)))
    .map(([category]) => category as SensitiveCategory);

  if (categories.length === 0) {
    return {
      includeInLocalReport: true,
      includeInLlmPayload: true,
      categories,
    };
  }

  return {
    includeInLocalReport: false,
    includeInLlmPayload: false,
    categories,
    reason: `Excluded by sensitive-topic policy: ${categories.join(", ")}`,
  };
}

export function summarizePrivacyDecisions(texts: string[]): {
  includedCount: number;
  excludedCount: number;
  excludedByCategory: Record<SensitiveCategory, number>;
} {
  const excludedByCategory = Object.fromEntries(
    Object.keys(CATEGORY_PATTERNS).map((category) => [category, 0]),
  ) as Record<SensitiveCategory, number>;
  let includedCount = 0;
  let excludedCount = 0;

  for (const text of texts) {
    const decision = classifyPrivacy(text);
    if (decision.includeInLlmPayload) {
      includedCount += 1;
      continue;
    }

    excludedCount += 1;
    for (const category of decision.categories) {
      excludedByCategory[category] += 1;
    }
  }

  return {
    includedCount,
    excludedCount,
    excludedByCategory,
  };
}
