import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyPrivacy } from "../src/privacy/policy.js";
import { redactText } from "../src/privacy/redact.js";

test("classifies common credential formats as excluded", () => {
  const samples = [
    `Authorization: Bearer ${"a".repeat(32)}`,
    `AWS key ${"AKIA"}${"A".repeat(16)}`,
    `npm token ${"npm_"}${"a".repeat(32)}`,
    `jwt ${["eyJ" + "a".repeat(24), "b".repeat(24), "c".repeat(24)].join(".")}`,
    ["-----BEGIN PRIVATE KEY-----", "secret", "-----END PRIVATE KEY-----"].join("\n"),
  ];

  for (const sample of samples) {
    const decision = classifyPrivacy(sample);
    assert.equal(decision.includeInLocalReport, false, sample);
    assert.equal(decision.includeInLlmPayload, false, sample);
  }
});

test("redacts common credential formats", () => {
  const awsKey = `${"AKIA"}${"A".repeat(16)}`;
  const npmToken = `${"npm_"}${"a".repeat(32)}`;
  const input = [
    `Authorization: Bearer ${"a".repeat(32)}`,
    `AWS key ${awsKey}`,
    `npm token ${npmToken}`,
    `jwt ${["eyJ" + "a".repeat(24), "b".repeat(24), "c".repeat(24)].join(".")}`,
    ["-----BEGIN PRIVATE KEY-----", "secret", "-----END PRIVATE KEY-----"].join("\n"),
  ].join("\n");

  const redacted = redactText(input);
  assert.ok(redacted.replacements >= 5);
  assert.doesNotMatch(redacted.text, new RegExp(awsKey));
  assert.doesNotMatch(redacted.text, new RegExp(npmToken));
  assert.doesNotMatch(redacted.text, /BEGIN PRIVATE KEY/);
});
