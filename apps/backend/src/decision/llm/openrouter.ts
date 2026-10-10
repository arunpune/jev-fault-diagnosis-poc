// SPDX-FileCopyrightText: 2026 Ameya Borkar, VIT
// SPDX-License-Identifier: Apache-2.0

/**
 * The second {@link LlmProvider}: OpenRouter's OpenAI-compatible Chat
 * Completions API (docs/decision-backends.md#through-openrouter).
 *
 * Author: Ameya Borkar, VIT. Added so the LLM backend can run on any model OpenRouter
 * serves, free ones included, selected with `LLM_PROVIDER=openrouter`.
 *
 * OpenRouter fronts many models, free ones among them, behind one key and one
 * wire shape. The request asks for structured output with
 * `response_format = { type: "json_schema", json_schema: { strict: true, … } }`
 * and `provider.require_parameters`, so OpenRouter only routes the call to an
 * upstream that honours the schema instead of silently dropping it.
 *
 * The JSON Schema is the one `zodOutputFormat` builds for the Anthropic
 * provider: every object closed, every property required. That is the shape
 * strict mode needs on this API too, and it keeps the two providers
 * constraining the model to one answer.
 *
 * ## No SDK
 *
 * The call is one `fetch`, so this module maps the transport itself: HTTP
 * statuses through {@link KIND_BY_STATUS}, an error object inside a 200 body
 * (OpenRouter's way of reporting an upstream failure mid-stream) the same way,
 * and `fetch`'s own rejections to `timeout` or `network`. 429, 502 and 503 are
 * retried {@link DEFAULT_MAX_RETRIES} times with a short backoff, as the
 * Anthropic SDK does for its own retryable statuses.
 *
 * ## Stop reason first, content second
 *
 * As in `anthropic.ts`: `length` and `content_filter` leave an answer that
 * must not be believed, so they come back as `parsed: null` before the content
 * is read. Otherwise the content is parsed as JSON — with a surrounding Markdown
 * fence stripped, which some models add even under a schema — and `index.ts`
 * validates it against the schema.
 *
 * The key is revealed once, into the `Authorization` header of each request.
 * Nothing this module returns carries a header.
 */

import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

import type { Secret } from "../../config/secret.ts";
import { DecisionError } from "../types.ts";
import type { DecisionErrorKind } from "../types.ts";
import { DEFAULT_MAX_RETRIES, DEFAULT_TIMEOUT_MS } from "./anthropic.ts";
import type { LlmCallOptions, LlmCompletion, LlmProvider, LlmRequest } from "./provider.ts";

/** The provider's name, as `LlmProvider.name` and `LLM_PROVIDER` spell it. */
export const OPENROUTER_PROVIDER = "openrouter";

/** Where the API lives when `LLM_BASE_URL` is unset. */
export const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * The output budget of one decision.
 *
 * Twice the Anthropic provider's: many models OpenRouter serves reason before
 * they answer, and the reasoning is billed against the same budget.
 */
export const MAX_TOKENS = 8192;

/** The name the structured-output schema travels under. */
export const SCHEMA_NAME = "fault_decision";

/** The first retry waits this long; each later one twice as long. */
const RETRY_BASE_MS = 500;

/** HTTP statuses whose meaning for a decision is fixed. */
const KIND_BY_STATUS: ReadonlyMap<number, DecisionErrorKind> = new Map<number, DecisionErrorKind>([
  [400, "validation"],
  [401, "auth"],
  // Out of credits: the key works but can buy nothing.
  [402, "auth"],
  // A key without access, or a prompt the moderation step flagged.
  [403, "auth"],
  // No upstream serves the model with every parameter the request needs.
  [404, "validation"],
  [408, "timeout"],
  [413, "validation"],
  [422, "validation"],
  [429, "rate_limit"],
  // The upstream model is down or answered with something invalid.
  [502, "overloaded"],
  [503, "overloaded"],
]);

/** Statuses worth asking again. */
const RETRYABLE: ReadonlySet<number> = new Set([429, 502, 503]);

/** Finish reasons that mean "there is no answer to read". */
const NO_ANSWER_FINISH_REASONS: ReadonlySet<string> = new Set(["length", "content_filter"]);

/** What {@link createOpenRouterProvider} needs to talk to the API. */
export interface OpenRouterProviderOptions {
  /** `LLM_API_KEY`, revealed into each request's `Authorization` header. */
  readonly apiKey: Secret;
  /** `LLM_MODEL`, an OpenRouter model id such as `vendor/model:free`. */
  readonly model: string;
  /** Per-call deadline; {@link DEFAULT_TIMEOUT_MS} when unset. */
  readonly timeoutMs?: number;
  /** Where the API lives (`LLM_BASE_URL`); {@link DEFAULT_BASE_URL} when unset. */
  readonly baseURL?: string;
  /** How often a 429, 502 or 503 is retried; `0` in tests. */
  readonly maxRetries?: number;
  /** The `fetch` to call; the global one when unset. Tests pass a double. */
  readonly fetch?: typeof fetch;
}

/** The parts of a Chat Completions response this module reads. */
interface ChatCompletion {
  readonly id?: string;
  readonly model?: string;
  readonly choices?: readonly {
    readonly finish_reason?: string | null;
    readonly message?: { readonly content?: string | null; readonly refusal?: string | null };
  }[];
  readonly usage?: { readonly prompt_tokens?: number; readonly completion_tokens?: number };
  readonly error?: { readonly code?: number | string; readonly message?: string };
}

/** An unknown throwable's message, without assuming it is an `Error`. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The failure a status (and the message the API gave with it) stands for. */
function statusError(status: number, message: string, requestId?: string): DecisionError {
  const kind = KIND_BY_STATUS.get(status) ?? "unknown";
  return new DecisionError(kind, `openrouter returned ${String(status)}: ${message}`, {
    status,
    ...(requestId === undefined ? {} : { request_id: requestId }),
  });
}

/** `fetch`'s own rejection as a {@link DecisionError}. */
function transportError(error: unknown, timedOut: boolean, aborted: boolean): DecisionError {
  if (timedOut) return new DecisionError("timeout", "openrouter did not answer in time");
  if (aborted) return new DecisionError("timeout", "the openrouter call was aborted");
  return new DecisionError("network", `openrouter is unreachable: ${messageOf(error)}`);
}

/** The error message of a failed response body, or a fallback when it has none. */
function errorMessage(body: unknown, fallback: string): string {
  const message = (body as ChatCompletion | null)?.error?.message;
  return typeof message === "string" && message !== "" ? message : fallback;
}

/** Content with one surrounding Markdown code fence removed, if it has one. */
export function stripFence(content: string): string {
  const fenced = /^\s*```[a-zA-Z]*\s*\n([\s\S]*?)\n?\s*```\s*$/.exec(content);
  return fenced?.[1] ?? content;
}

/** Wait `ms`, or stop early when `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** How long to wait before retry `attempt` (0-based), honouring `retry-after` when it is sane. */
function retryDelay(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 10) return seconds * 1000;
  return RETRY_BASE_MS * 2 ** attempt;
}

/** Build the OpenRouter provider. */
export function createOpenRouterProvider(options: OpenRouterProviderOptions): LlmProvider {
  const {
    model,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRetries = DEFAULT_MAX_RETRIES,
    baseURL = DEFAULT_BASE_URL,
  } = options;
  const call = options.fetch ?? fetch;
  const url = `${baseURL.replace(/\/+$/, "")}/chat/completions`;
  const authorization = `Bearer ${options.apiKey.reveal()}`;

  /** POST `body`, retrying what is worth retrying; the parsed 200 body or a DecisionError. */
  async function post(body: unknown, signal: AbortSignal | undefined): Promise<ChatCompletion> {
    // Ameya Borkar, VIT: one deadline covers the whole call, retries included, and is
    // joined with the caller's own abort signal when there is one.
    const deadline = AbortSignal.timeout(timeoutMs);
    const combined = signal === undefined ? deadline : AbortSignal.any([deadline, signal]);

    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await call(url, {
          method: "POST",
          headers: {
            authorization,
            "content-type": "application/json",
            "x-title": "Fault Diagnosis PoC",
          },
          body: JSON.stringify(body),
          signal: combined,
        });
      } catch (error) {
        throw transportError(error, deadline.aborted, signal?.aborted === true);
      }

      // Ameya Borkar, VIT: read the body once; a failed response usually explains itself in it.
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch (error) {
        if (deadline.aborted || signal?.aborted === true) {
          throw transportError(error, deadline.aborted, signal?.aborted === true);
        }
        parsed = null;
      }

      if (response.ok) {
        const completion = parsed as ChatCompletion | null;
        if (completion === null || typeof completion !== "object") {
          throw new DecisionError(
            "unknown",
            "openrouter answered 200 with a body that is not JSON",
          );
        }
        // An upstream failure can arrive inside a 200: the error object carries its status.
        if (completion.error !== undefined) {
          const status = Number(completion.error.code);
          throw statusError(
            Number.isInteger(status) ? status : 500,
            errorMessage(completion, "upstream error"),
            completion.id,
          );
        }
        return completion;
      }

      // Ameya Borkar, VIT: rate limits and upstream outages are retried while time remains;
      // every other status is final.
      if (RETRYABLE.has(response.status) && attempt < maxRetries && !combined.aborted) {
        await pause(retryDelay(attempt, response.headers.get("retry-after")), combined);
        if (!combined.aborted) continue;
      }
      throw statusError(response.status, errorMessage(parsed, response.statusText));
    }
  }

  return {
    name: OPENROUTER_PROVIDER,
    model,

    async complete(request: LlmRequest, callOptions: LlmCallOptions = {}): Promise<LlmCompletion> {
      // Ameya Borkar, VIT: the same closed JSON Schema the Anthropic provider sends, as strict
      // structured output; `require_parameters` stops OpenRouter from routing to an
      // upstream that would ignore it.
      const { schema } = zodOutputFormat(request.schema);
      const body = {
        model,
        max_tokens: MAX_TOKENS,
        messages: [
          { role: "system" as const, content: request.system },
          { role: "user" as const, content: request.user },
        ],
        response_format: {
          type: "json_schema" as const,
          json_schema: { name: SCHEMA_NAME, strict: true, schema },
        },
        provider: { require_parameters: true },
      };

      const completion = await post(body, callOptions.signal);
      const choice = completion.choices?.[0];
      if (choice === undefined) {
        throw new DecisionError("unknown", "openrouter answered with no choice", {
          ...(completion.id === undefined ? {} : { request_id: completion.id }),
        });
      }

      // Ameya Borkar, VIT: the stop reason is read before the content, in this order: a
      // refusal, a cut-off or filtered reply, an empty reply, and only then JSON.
      const finishReason = choice.finish_reason ?? null;
      const refusal = choice.message?.refusal;
      const content = choice.message?.content;
      let parsed: unknown = null;
      let detail: string | undefined;
      let stopReason: string | null = finishReason;

      if (typeof refusal === "string" && refusal !== "") {
        stopReason = "refusal";
        detail = refusal;
      } else if (finishReason !== null && NO_ANSWER_FINISH_REASONS.has(finishReason)) {
        if (finishReason === "length") stopReason = "max_tokens";
        detail = `finish reason: ${finishReason}`;
      } else if (typeof content !== "string" || content.trim() === "") {
        detail = "the reply has no content";
      } else {
        try {
          parsed = JSON.parse(stripFence(content));
        } catch (error) {
          detail = messageOf(error);
        }
      }

      return {
        parsed,
        usage: {
          input_tokens: completion.usage?.prompt_tokens ?? 0,
          output_tokens: completion.usage?.completion_tokens ?? 0,
        },
        model: completion.model ?? model,
        stop_reason: stopReason,
        ...(parsed === null && detail !== undefined ? { detail } : {}),
        ...(completion.id === undefined ? {} : { request_id: completion.id }),
        // What `app.decisions` stores: the bodies as sent and received, no headers.
        raw: { request: body, response: completion },
      };
    },
  };
}
