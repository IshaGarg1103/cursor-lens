import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSynthesisPayload } from "../src/analysis/synthesisPayload.js";
import type { TranscriptSession, WorkspaceSummary } from "../src/types/transcript.js";

test("AI synthesis payload does not include local workspace paths", () => {
  const workspace: WorkspaceSummary = {
    key: "Users-alice-private-project",
    displayName: "Users-alice-private-project",
    inferredPath: "/Users/alice/private-project",
    transcriptRoot: "/Users/alice/.cursor/projects/private/agent-transcripts",
    sessionCount: 1,
    eventCount: 2,
    userMessageCount: 1,
    assistantMessageCount: 1,
    toolCallCount: 0,
  };
  const sessions: TranscriptSession[] = [
    {
      id: "session-1",
      sourcePath: "/Users/alice/.cursor/projects/private/agent-transcripts/session.jsonl",
      workspaceKey: workspace.key,
      isSubagent: false,
      parseErrors: [],
      events: [
        {
          sessionId: "session-1",
          sourcePath: "session.jsonl",
          role: "user",
          text: "Please review the component and suggest a cleaner approach.",
          fileRefs: ["/Users/alice/private-project/src/components/SecretPanel.tsx"],
          rawLine: 1,
        },
        {
          sessionId: "session-1",
          sourcePath: "session.jsonl",
          role: "assistant",
          text: "I will review it.",
          fileRefs: ["/Users/alice/private-project/src/components/SecretPanel.tsx"],
          rawLine: 2,
        },
      ],
    },
  ];

  const payload = buildSynthesisPayload({ workspace, sessions });
  const serialized = JSON.stringify(payload);

  assert.equal(payload.workspace.displayName, "Selected workspace");
  assert.doesNotMatch(serialized, /alice/);
  assert.doesNotMatch(serialized, /private-project/);
  assert.match(serialized, /SecretPanel\.tsx/);
});
