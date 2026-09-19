// Regression coverage for Landing 3 (2026-09-19): Perplexity Sonar Chat
// Completions is deprecated 2026-09-27. This file adds an Agent API branch
// gated on LLM_PRIMARY_DIGEST=agent-api, preserving the {text, citations}
// return contract so the sole caller (leaderboard-digest.ts) doesn't need
// to change.
//
// The tests below pin:
//   - the Agent API response walkers (__extractAgentText,
//     __extractAgentCitations) against the migration-guide's response shape
//   - the router (callLlm) picks the correct backend per env var / override
//   - the Agent API wire body matches the migration guide's request-mapping
//     table (preset, instructions, input, tools[web_search].filters)
//   - the sonar-default path stays wire-identical (regression guard for
//     the sonar-pro production behavior)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  callLlm,
  __extractAgentText,
  __extractAgentCitations,
  __setBackendOverride,
} from "./sonar-client";
import { storage } from "./storage";

// ---------------------------------------------------------------------------
// Helper: mock fetch and storage.getSetting
// ---------------------------------------------------------------------------

function withMockedFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl as any;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

function withMockedApiKey<T>(key: string | null, fn: () => Promise<T>): Promise<T> {
  const original = (storage as any).getSetting;
  (storage as any).getSetting = (name: string) =>
    name === "perplexity_api_key" && key ? { value: key } : undefined;
  return fn().finally(() => {
    (storage as any).getSetting = original;
  });
}

// ---------------------------------------------------------------------------
// __extractAgentText
// ---------------------------------------------------------------------------

test("__extractAgentText reads content[0].text from the first message item", () => {
  const parsed = {
    output: [
      { type: "search_results", results: [] },
      {
        type: "message",
        content: [{ text: "  This is the answer.  " }],
      },
    ],
  };
  assert.equal(__extractAgentText(parsed), "This is the answer.");
});

test("__extractAgentText falls back to top-level output_text if walk empty", () => {
  const parsed = { output: [], output_text: "fallback answer" };
  assert.equal(__extractAgentText(parsed), "fallback answer");
});

test("__extractAgentText returns empty string on malformed shapes", () => {
  assert.equal(__extractAgentText(null), "");
  assert.equal(__extractAgentText({}), "");
  assert.equal(__extractAgentText({ output: "not-an-array" }), "");
  assert.equal(__extractAgentText({ output: [{ type: "message", content: [] }] }), "");
  assert.equal(__extractAgentText({ output: [{ type: "message", content: [{ text: "   " }] }] }), "");
});

// ---------------------------------------------------------------------------
// __extractAgentCitations
// ---------------------------------------------------------------------------

test("__extractAgentCitations pulls URLs from the search_results item", () => {
  const parsed = {
    output: [
      {
        type: "search_results",
        results: [
          { url: "https://example.com/a", title: "A" },
          { url: "https://example.com/b", title: "B" },
          { url: "not-a-url" },
        ],
      },
      { type: "message", content: [{ text: "answer" }] },
    ],
  };
  assert.deepEqual(__extractAgentCitations(parsed), [
    "https://example.com/a",
    "https://example.com/b",
  ]);
});

test("__extractAgentCitations returns [] when no search results item is present", () => {
  const parsed = { output: [{ type: "message", content: [{ text: "hi" }] }] };
  assert.deepEqual(__extractAgentCitations(parsed), []);
});

test("__extractAgentCitations handles empty results array (search returned nothing)", () => {
  const parsed = {
    output: [
      { type: "search_results", results: [] },
      { type: "message", content: [{ text: "hi" }] },
    ],
  };
  assert.deepEqual(__extractAgentCitations(parsed), []);
});

// ---------------------------------------------------------------------------
// Router: callLlm picks the right backend
// ---------------------------------------------------------------------------

test("callLlm defaults to Sonar (chat/completions) when no override or env", async () => {
  __setBackendOverride(undefined);
  const originalEnv = process.env.LLM_PRIMARY_DIGEST;
  delete process.env.LLM_PRIMARY_DIGEST;
  try {
    let calledUrl = "";
    await withMockedApiKey("test-key", () =>
      withMockedFetch(
        (async (url: string, init: any) => {
          calledUrl = String(url);
          return new Response(
            JSON.stringify({ choices: [{ message: { content: "sonar output" } }], citations: [] }),
            { status: 200 },
          );
        }) as any,
        async () => {
          const r = await callLlm("prompt");
          assert.equal(r?.text, "sonar output");
        },
      ),
    );
    assert.equal(calledUrl, "https://api.perplexity.ai/chat/completions");
  } finally {
    if (originalEnv !== undefined) process.env.LLM_PRIMARY_DIGEST = originalEnv;
  }
});

test("callLlm routes to Agent API when override is 'agent-api'", async () => {
  __setBackendOverride("agent-api");
  try {
    let calledUrl = "";
    let bodyJson: any = null;
    await withMockedApiKey("test-key", () =>
      withMockedFetch(
        (async (url: string, init: any) => {
          calledUrl = String(url);
          bodyJson = JSON.parse(init.body);
          return new Response(
            JSON.stringify({
              output: [
                {
                  type: "search_results",
                  results: [{ url: "https://source.example.com/story" }],
                },
                { type: "message", content: [{ text: "Agent output." }] },
              ],
            }),
            { status: 200 },
          );
        }) as any,
        async () => {
          const r = await callLlm("summarize this week", {
            searchAfterDateFilter: "09/10/2026",
            searchBeforeDateFilter: "09/17/2026",
          });
          assert.equal(r?.text, "Agent output.");
          assert.deepEqual(r?.citations, ["https://source.example.com/story"]);
        },
      ),
    );
    assert.equal(calledUrl, "https://api.perplexity.ai/v1/agent");
  } finally {
    __setBackendOverride(undefined);
  }
});

// ---------------------------------------------------------------------------
// Wire body shape (Agent API)
// ---------------------------------------------------------------------------

test("Agent API request body matches migration guide (preset, instructions, input, filters)", async () => {
  __setBackendOverride("agent-api");
  try {
    let bodyJson: any = null;
    await withMockedApiKey("k", () =>
      withMockedFetch(
        (async (_url: string, init: any) => {
          bodyJson = JSON.parse(init.body);
          return new Response(
            JSON.stringify({ output: [{ type: "message", content: [{ text: "ok" }] }] }),
            { status: 200 },
          );
        }) as any,
        async () => {
          await callLlm("hello", {
            searchAfterDateFilter: "09/10/2026",
            searchBeforeDateFilter: "09/17/2026",
            searchContextSize: "high",
          });
        },
      ),
    );

    // Field renames per migration guide's request-mapping.md
    assert.equal(bodyJson.preset, "low", "sonar-pro behavioral match is preset='low'");
    assert.ok(typeof bodyJson.instructions === "string" && bodyJson.instructions.length > 0,
      "system prompt migrates to top-level `instructions`");
    assert.deepEqual(bodyJson.input, [{ role: "user", content: "hello" }],
      "user prompt migrates to `input` array");
    assert.equal(bodyJson.max_output_tokens, 350, "max_tokens migrates to max_output_tokens");
    // Sonar-only fields must be absent (Agent API rejects unknown top-level fields with 400)
    assert.equal(bodyJson.messages, undefined, "no top-level `messages`");
    assert.equal(bodyJson.model, undefined, "no top-level `model` when preset is set");
    assert.equal(bodyJson.search_after_date_filter, undefined,
      "date filters must NOT be at top level");
    assert.equal(bodyJson.web_search_options, undefined,
      "Sonar web_search_options replaced by tools[web_search]");
    // Web search + date filters live inside tools[0]
    assert.equal(bodyJson.tools?.[0]?.type, "web_search");
    assert.equal(bodyJson.tools?.[0]?.search_context_size, "high");
    assert.equal(bodyJson.tools?.[0]?.filters?.search_after_date_filter, "09/10/2026");
    assert.equal(bodyJson.tools?.[0]?.filters?.search_before_date_filter, "09/17/2026");
    // Force citations via tool_choice per migration guide's guidance
    assert.equal(bodyJson.tool_choice?.type, "web_search");
  } finally {
    __setBackendOverride(undefined);
  }
});

test("Agent API omits filters block when no date-scoped search is requested", async () => {
  __setBackendOverride("agent-api");
  try {
    let bodyJson: any = null;
    await withMockedApiKey("k", () =>
      withMockedFetch(
        (async (_url: string, init: any) => {
          bodyJson = JSON.parse(init.body);
          return new Response(
            JSON.stringify({ output: [{ type: "message", content: [{ text: "ok" }] }] }),
            { status: 200 },
          );
        }) as any,
        async () => { await callLlm("hi"); },
      ),
    );
    assert.equal(bodyJson.tools[0].filters, undefined,
      "when no dates provided, the entire filters block is omitted");
    assert.equal(bodyJson.tools[0].search_context_size, "medium",
      "search_context_size defaults to 'medium'");
  } finally {
    __setBackendOverride(undefined);
  }
});

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

test("Agent API returns null when API key missing", async () => {
  __setBackendOverride("agent-api");
  try {
    const r = await withMockedApiKey(null, async () => await callLlm("hi"));
    assert.equal(r, null);
  } finally {
    __setBackendOverride(undefined);
  }
});

test("Agent API returns null on HTTP error", async () => {
  __setBackendOverride("agent-api");
  try {
    const r = await withMockedApiKey("k", () =>
      withMockedFetch(
        (async () => new Response("boom", { status: 500 })) as any,
        () => callLlm("hi"),
      ),
    );
    assert.equal(r, null);
  } finally {
    __setBackendOverride(undefined);
  }
});

test("Agent API returns null when response has empty content", async () => {
  __setBackendOverride("agent-api");
  try {
    const r = await withMockedApiKey("k", () =>
      withMockedFetch(
        (async () => new Response(JSON.stringify({ output: [] }), { status: 200 })) as any,
        () => callLlm("hi"),
      ),
    );
    assert.equal(r, null);
  } finally {
    __setBackendOverride(undefined);
  }
});

// ---------------------------------------------------------------------------
// Sonar-default regression guard
// ---------------------------------------------------------------------------

test("Sonar default wire body still uses messages+model (no accidental Agent API leak)", async () => {
  __setBackendOverride("sonar");
  try {
    let bodyJson: any = null;
    await withMockedApiKey("k", () =>
      withMockedFetch(
        (async (_url: string, init: any) => {
          bodyJson = JSON.parse(init.body);
          return new Response(
            JSON.stringify({ choices: [{ message: { content: "sonar" } }], citations: [] }),
            { status: 200 },
          );
        }) as any,
        async () => { await callLlm("hi"); },
      ),
    );
    assert.equal(bodyJson.model, "sonar");
    assert.ok(Array.isArray(bodyJson.messages), "Sonar path still uses messages array");
    assert.equal(bodyJson.preset, undefined, "Sonar path must not send preset");
    assert.equal(bodyJson.instructions, undefined, "Sonar path must not send instructions");
    assert.equal(bodyJson.input, undefined, "Sonar path must not send input");
  } finally {
    __setBackendOverride(undefined);
  }
});
