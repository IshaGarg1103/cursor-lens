import assert from "node:assert/strict";
import { test } from "node:test";
import { identifyBuilderArchetype } from "../src/analysis/archetypes.js";
import { computeProfileMetrics } from "../src/analysis/metrics.js";
import type { TranscriptSession } from "../src/types/transcript.js";

test("classifies publishing and command-heavy chats as Operator", () => {
  const sessions = makeSessions([
    "Let's publish this package to npm and verify the npx command.",
    "Run the build, dry-run the publish, and handle the registry login with otp.",
  ]);
  const metrics = computeProfileMetrics(sessions);
  const archetype = identifyBuilderArchetype(sessions, metrics);

  assert.equal(archetype.name, "Operator");
  assert.ok(archetype.score > 0);
});

test("classifies repo discovery chats as Explorer", () => {
  const sessions = makeSessions([
    "Can you summarize this folder and map the repo structure?",
    "Inspect the codebase and tell me where the parser and report rendering live.",
  ]);
  const metrics = computeProfileMetrics(sessions);
  const archetype = identifyBuilderArchetype(sessions, metrics);

  assert.equal(archetype.name, "Explorer");
});

test("classifies polish and accuracy requests as Refiner", () => {
  const sessions = makeSessions([
    "Remove the sloppy wording and make this profile more accurate.",
    "Improve the layout, polish the copy, and make the ID card look nice.",
  ]);
  const metrics = computeProfileMetrics(sessions);
  const archetype = identifyBuilderArchetype(sessions, metrics);

  assert.equal(archetype.name, "Refiner");
});

function makeSessions(userMessages: string[]): TranscriptSession[] {
  return [
    {
      id: "session-1",
      sourcePath: "session.jsonl",
      workspaceKey: "workspace",
      isSubagent: false,
      parseErrors: [],
      events: userMessages.map((text, index) => ({
        sessionId: "session-1",
        sourcePath: "session.jsonl",
        role: "user",
        text,
        fileRefs: [],
        rawLine: index + 1,
      })),
    },
  ];
}
