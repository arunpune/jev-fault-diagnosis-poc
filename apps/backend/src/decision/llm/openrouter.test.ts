// SPDX-FileCopyrightText: 2026 Ameya Borkar, VIT
// SPDX-License-Identifier: Apache-2.0

/**
 * The OpenRouter provider against a scripted `fetch`.
 *
 * Author: Ameya Borkar, VIT.
 *
 * The provider is one `fetch` with no SDK in between, so a double that records
 * each request and answers from a script is enough to pin the wire shape, the
 * reading of the reply and the mapping of every failure. Every provider is
 * built with `maxRetries: 0` except the cases about retries, so the request
 * count is part of the assertion.
 */

import { describe, expect, it } from "vitest";

import { candidatesFor, FIXTURE_LABELS } from "../../../test/fixtures/catalog/index.ts";
import {
  FIXTURE_UNIT_ID,
  SIGNATURE_A_CANDIDATE_IDS,
  SIGNATURE_A_EVENT,
} from "../../../test/fixtures/catalog/events.ts";
import { fixedClock } from "../../clock.ts";
import { Secret } from "../../config/secret.ts";
import { buildState } from "../state.ts";
import { isDecisionError, NONE_OF_THESE } from "../types.ts";
import type { DecisionError, DecisionInput } from "../types.ts";
import { createLlmBackend, SYSTEM_PROMPT } from "./index.ts";
import {
  createOpenRouterProvider,
  DEFAULT_BASE_URL,
  MAX_TOKENS,
  SCHEMA_NAME,
  stripFence,
} from "./openrouter.ts";
import type { OpenRouterProviderOptions } from "./openrouter.ts";
import type { LlmProvider, LlmRequest } from "./provider.ts";
import { DecisionSchema } from "./schema.ts";
import type { DecisionAnswer } from "./schema.ts";

/** A test value, never a real key. */
const TEST_KEY = "sk-or-test-fdp-0001";

const MODEL = "vendor/some-model:free";

const INPUT: DecisionInput = {
  event: SIGNATURE_A_EVENT,
  candidates: candidatesFor(SIGNATURE_A_CANDIDATE_IDS),
  unit_id: FIXTURE_UNIT_ID,
};

const STATE_JSON = JSON.stringify(buildState(INPUT, FIXTURE_LABELS));

const REQUEST: LlmRequest = { system: SYSTEM_PROMPT, user: STATE_JSON, schema: DecisionSchema };

const ANSWER: DecisionAnswer = {
  choice: "dryer_purge_leak",
  probabilities: [
    { id: "dryer_purge_leak", probability: 0.82 },
    { id: "purge_silencer_damaged", probability: 0.08 },
    { id: "downstream_air_leak", probability: 0.04 },
    { id: "high_air_demand", probability: 0.03 },
    { id: "intake_filter_clogged", probability: 0.01 },
    { id: "airend_element_wear", probability: 0.01 },
    { id: NONE_OF_THESE, probability: 0.01 },
  ],
  support: [
    { id: "dryer_purge_leak", support: 0.95 },
    { id: "purge_silencer_damaged", support: 0.6 },
    { id: "high_air_demand", support: 0.05 },
  ],
  severity_level: "high",
  severity_confidence: 0.7,
  rationale: "Purge pressure sits far above normal while the unit never reaches its cut-out.",
};

/** One recorded request. */
interface Recorded {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

/** One scripted reply: a status and a JSON body, or a rejection. */
type Reply =
  { status: number; body: unknown; headers?: Record<string, string> } | { reject: Error };

/** A `fetch` double that answers from `replies` in order, repeating the last. */
function scripted(replies: readonly Reply[]): { fetch: typeof fetch; requests: Recorded[] } {
  const requests: Recorded[] = [];
  const double = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const signal = init?.signal;
    if (signal?.aborted === true) return Promise.reject(signal.reason as Error);
    requests.push({
      url: String(input),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    const reply = replies[Math.min(requests.length, replies.length) - 1];
    if (reply === undefined) throw new Error("no reply scripted");
    if ("reject" in reply) return Promise.reject(reply.reject);
    return Promise.resolve(
      new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { "content-type": "application/json", ...reply.headers },
      }),
    );
  };
  return { fetch: double as typeof fetch, requests };
}

/** A 200 Chat Completions body around `content`. */
function completion(
  content: string | null,
  extra: { finish_reason?: string; refusal?: string; model?: string } = {},
): Reply {
  return {
    status: 200,
    body: {
      id: "gen-test-0001",
      model: extra.model ?? MODEL,
      choices: [
        {
          finish_reason: extra.finish_reason ?? "stop",
          message: { role: "assistant", content, refusal: extra.refusal ?? null },
        },
      ],
      usage: { prompt_tokens: 1_234, completion_tokens: 210 },
    },
  };
}

function provider(
  replies: readonly Reply[],
  overrides: Partial<OpenRouterProviderOptions> = {},
): { provider: LlmProvider; requests: Recorded[] } {
  const double = scripted(replies);
  return {
    provider: createOpenRouterProvider({
      apiKey: new Secret(TEST_KEY),
      model: MODEL,
      maxRetries: 0,
      timeoutMs: 5_000,
      fetch: double.fetch,
      ...overrides,
    }),
    requests: double.requests,
  };
}

/** The `DecisionError` a promise rejected with; anything else fails the test. */
async function failureOf(pending: Promise<unknown>): Promise<DecisionError> {
  const caught: unknown = await pending.then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!isDecisionError(caught)) throw new Error(`expected a DecisionError, got ${String(caught)}`);
  return caught;
}

describe("the request", () => {
  it("is a Chat Completions call with a strict json_schema response format", async () => {
    const { provider: p, requests } = provider([completion(JSON.stringify(ANSWER))]);
    await p.complete(REQUEST);

    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.url).toBe(`${DEFAULT_BASE_URL}/chat/completions`);
    expect(request?.headers["authorization"]).toBe(`Bearer ${TEST_KEY}`);

    const body = request?.body ?? {};
    expect(body["model"]).toBe(MODEL);
    expect(body["max_tokens"]).toBe(MAX_TOKENS);
    expect(body["messages"]).toEqual([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: STATE_JSON },
    ]);
    expect(body["provider"]).toEqual({ require_parameters: true });

    const format = body["response_format"] as {
      type: string;
      json_schema: { name: string; strict: boolean; schema: Record<string, unknown> };
    };
    expect(format.type).toBe("json_schema");
    expect(format.json_schema.name).toBe(SCHEMA_NAME);
    expect(format.json_schema.strict).toBe(true);
    const schema = format.json_schema.schema as { properties: object; required: string[] };
    expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
    expect(schema).toHaveProperty("additionalProperties", false);
  });

  it("goes to LLM_BASE_URL when one is set, without a doubled slash", async () => {
    const { provider: p, requests } = provider([completion(JSON.stringify(ANSWER))], {
      baseURL: "http://localhost:9999/api/v1/",
    });
    await p.complete(REQUEST);
    expect(requests[0]?.url).toBe("http://localhost:9999/api/v1/chat/completions");
  });

  it("records the body for app.decisions without the key", async () => {
    const { provider: p } = provider([completion(JSON.stringify(ANSWER))]);
    const result = await p.complete(REQUEST);
    expect(JSON.stringify(result.raw)).not.toContain(TEST_KEY);
  });
});

describe("an answered call", () => {
  it("hands back the parsed answer with usage, model, stop reason and generation id", async () => {
    const { provider: p } = provider([completion(JSON.stringify(ANSWER))]);
    const result = await p.complete(REQUEST);

    expect(result.parsed).toEqual(ANSWER);
    expect(result.usage).toEqual({ input_tokens: 1_234, output_tokens: 210 });
    expect(result.model).toBe(MODEL);
    expect(result.stop_reason).toBe("stop");
    expect(result.request_id).toBe("gen-test-0001");
    expect(result.detail).toBeUndefined();
  });

  it("reads an answer a model wrapped in a Markdown fence", async () => {
    const fenced = "```json\n" + JSON.stringify(ANSWER) + "\n```";
    const { provider: p } = provider([completion(fenced)]);
    expect((await p.complete(REQUEST)).parsed).toEqual(ANSWER);
  });

  it("reports the model OpenRouter routed to", async () => {
    const { provider: p } = provider([
      completion(JSON.stringify(ANSWER), { model: "vendor/other-model" }),
    ]);
    expect((await p.complete(REQUEST)).model).toBe("vendor/other-model");
  });

  it("becomes the backend's DecisionOutput end to end", async () => {
    const { provider: p } = provider([completion(JSON.stringify(ANSWER))]);
    const backend = createLlmBackend(p, fixedClock("2026-09-22T08:00:00.000Z"), {
      labels: FIXTURE_LABELS,
    });
    const output = await backend.decide(INPUT);

    expect(output.backend).toBe("llm");
    expect(output.model).toBe(MODEL);
    expect(output.choice).toBe("dryer_purge_leak");
    expect(output.usage).toEqual({ input_tokens: 1_234, output_tokens: 210 });
    expect(output.severity.level).toBe("high");
  });
});

describe("an answer that must not be believed", () => {
  it("reads a cut-off reply as max_tokens before touching its content", async () => {
    const { provider: p } = provider([completion('{"choice": "dry', { finish_reason: "length" })]);
    const result = await p.complete(REQUEST);
    expect(result.parsed).toBeNull();
    expect(result.stop_reason).toBe("max_tokens");
  });

  it("reads a refusal and keeps what the model said", async () => {
    const { provider: p } = provider([completion(null, { refusal: "I cannot help with that." })]);
    const result = await p.complete(REQUEST);
    expect(result.parsed).toBeNull();
    expect(result.stop_reason).toBe("refusal");
    expect(result.detail).toBe("I cannot help with that.");
  });

  it("turns content that is not JSON into a null parse with the reason", async () => {
    const { provider: p } = provider([completion("The dryer purge valve is leaking.")]);
    const result = await p.complete(REQUEST);
    expect(result.parsed).toBeNull();
    expect(result.detail).toBeDefined();
  });

  it("turns an empty reply into a null parse", async () => {
    const { provider: p } = provider([completion(null)]);
    const result = await p.complete(REQUEST);
    expect(result.parsed).toBeNull();
    expect(result.detail).toBe("the reply has no content");
  });

  it("is rejected by the backend with a validation DecisionError", async () => {
    const { provider: p } = provider([completion("not json")]);
    const backend = createLlmBackend(p, fixedClock("2026-09-22T08:00:00.000Z"));
    expect((await failureOf(backend.decide(INPUT))).kind).toBe("validation");
  });
});

describe("transport failures", () => {
  it.each([
    [400, "validation"],
    [401, "auth"],
    [402, "auth"],
    [404, "validation"],
    [429, "rate_limit"],
    [502, "overloaded"],
    [500, "unknown"],
  ] as const)("maps a %i to a %s DecisionError after one request", async (status, kind) => {
    const { provider: p, requests } = provider([
      { status, body: { error: { code: status, message: "scripted failure" } } },
    ]);
    const error = await failureOf(p.complete(REQUEST));

    expect(error.kind).toBe(kind);
    expect(error.status).toBe(status);
    expect(error.message).toContain("scripted failure");
    expect(requests).toHaveLength(1);
  });

  it("maps an upstream error inside a 200 body by its code", async () => {
    const { provider: p } = provider([
      { status: 200, body: { id: "gen-x", error: { code: 429, message: "upstream limited" } } },
    ]);
    const error = await failureOf(p.complete(REQUEST));
    expect(error.kind).toBe("rate_limit");
    expect(error.request_id).toBe("gen-x");
  });

  it("retries a 429 and answers once the limit lifts", async () => {
    const { provider: p, requests } = provider(
      [
        {
          status: 429,
          body: { error: { code: 429, message: "slow down" } },
          headers: { "retry-after": "0" },
        },
        completion(JSON.stringify(ANSWER)),
      ],
      { maxRetries: 2 },
    );
    expect((await p.complete(REQUEST)).parsed).toEqual(ANSWER);
    expect(requests).toHaveLength(2);
  });

  it("gives up after its retries", async () => {
    const { provider: p, requests } = provider(
      [{ status: 503, body: {}, headers: { "retry-after": "0" } }],
      { maxRetries: 2 },
    );
    expect((await failureOf(p.complete(REQUEST))).kind).toBe("overloaded");
    expect(requests).toHaveLength(3);
  });

  it("maps an aborted call to timeout", async () => {
    const { provider: p } = provider([completion(JSON.stringify(ANSWER))]);
    const controller = new AbortController();
    controller.abort();

    const error = await failureOf(p.complete(REQUEST, { signal: controller.signal }));
    expect(error.kind).toBe("timeout");
    expect(error.message).toContain("aborted");
  });

  it("maps a slow answer to timeout", async () => {
    const slow = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason as Error);
        });
      })) as typeof fetch;
    const p = createOpenRouterProvider({
      apiKey: new Secret(TEST_KEY),
      model: MODEL,
      timeoutMs: 50,
      maxRetries: 0,
      fetch: slow,
    });
    const error = await failureOf(p.complete(REQUEST));
    expect(error.kind).toBe("timeout");
    expect(error.message).toContain("in time");
  });

  it("maps a server that is not there to network", async () => {
    const { provider: p } = provider([{ reject: new TypeError("fetch failed") }]);
    const error = await failureOf(p.complete(REQUEST));
    expect(error.kind).toBe("network");
    expect(error.message).not.toContain(TEST_KEY);
  });
});

describe("stripFence", () => {
  it("leaves bare JSON alone and unwraps one fence", () => {
    expect(stripFence('{"a":1}')).toBe('{"a":1}');
    expect(stripFence('```\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripFence('  ```json\n{"a":1}\n```  ')).toBe('{"a":1}');
  });
});
