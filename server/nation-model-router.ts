// Task-complexity routing for NATION API.
//
// NATION API stays the only model and billing authority. This module only
// decides WHICH of the operator's allowed NATION API models a turn uses:
//
//   fast      short replies, classification, basic lookup
//   standard  research, ordinary coding, document analysis
//   strong    hard coding, architecture, long-context reasoning, debugging
//
// The policy is deterministic: the same inputs always give the same tier,
// and every decision carries the reasons that produced it. There is no
// randomness and no provider key anywhere near it.
//
// The allowed catalog is the operator's, set on the API process:
//
//   NATION_MODEL_FAST=openai/gpt-4o-mini
//   NATION_MODEL_STANDARD=openai/gpt-4.1
//   NATION_MODEL_STRONG=openai/o4-mini
//
// A tier left unset falls back to the next cheaper configured tier, and the
// cheapest to NATION's default model, so an unconfigured server behaves
// exactly as before (one model). Claude/Anthropic slugs are refused here as
// they are for NATION_OPENROUTER_MODEL.
import { appendFileSync } from "node:fs";
import { isClaudeOrAnthropicSlug, resolveNationModel } from "./nation-openrouter.ts";

export type ModelTier = "fast" | "standard" | "strong";
export const MODEL_TIERS: readonly ModelTier[] = ["fast", "standard", "strong"];

export interface ModelRouteCatalog {
  fast: string;
  standard: string;
  strong: string;
  /** Tiers the operator named explicitly (the rest are fallbacks). */
  configured: ModelTier[];
}

const MODEL_SLUG = /^[a-z0-9][\w.-]*\/[\w.:-]+$/i;

function allowedModel(value: string | undefined): string | undefined {
  const model = value?.trim();
  if (!model || !MODEL_SLUG.test(model) || isClaudeOrAnthropicSlug(model)) return undefined;
  return model;
}

/** The operator's allowed NATION API models per tier. */
export function modelRouteCatalog(env: NodeJS.ProcessEnv = process.env): ModelRouteCatalog {
  const base = resolveNationModel(env);
  const named: Partial<Record<ModelTier, string>> = {
    fast: allowedModel(env.NATION_MODEL_FAST),
    standard: allowedModel(env.NATION_MODEL_STANDARD),
    strong: allowedModel(env.NATION_MODEL_STRONG),
  };
  const fast = named.fast ?? base;
  const standard = named.standard ?? fast;
  const strong = named.strong ?? standard;
  return { fast, standard, strong, configured: MODEL_TIERS.filter((tier) => named[tier] !== undefined) };
}

export interface RouteInput {
  /** The person's message for this turn. */
  text: string;
  /** Attached files and images on it. */
  attachments?: number;
  /** Characters of earlier conversation the model will also read. */
  historyChars?: number;
  /** Tools mounted this turn (computer, browser, connected apps...). */
  tools?: { computer?: boolean; browser?: boolean; connectors?: boolean };
}

export interface RouteDecision {
  tier: ModelTier;
  model: string;
  /** A cheaper tier the runtime may fall back to if this model is unavailable. */
  fallback?: string;
  score: number;
  reasons: string[];
}

/** Strong on their own: the work named is hard by definition. */
const HARDEST = /\b(architect(?:ure)?|design (?:a|the) system|race condition|deadlock|memory leak|root cause|segfault|concurren(?:cy|t)|security review|threat model|formal(?:ly)? (?:verify|proof)|distributed system)\b/i;
/** Hard-leaning: strong once anything else adds weight. */
const HARD = /\b(refactor|debug(?:ging)?|stack ?trace|migrat(?:e|ion)|optimi[sz]e (?:the )?performance|prove|complex)\b/i;
const MEDIUM = /\b(research|analy[sz]e|analysis|summari[sz]e|compare|explain|review|write (?:a |the )?(?:function|script|code|test|report|document)|implement|document|draft|plan|investigate|code)\b/i;
const TRIVIAL = /^(?:hi|hello|hey|thanks?|thank you|ok(?:ay)?|yes|no|sure|good (?:morning|night)|what time is it)\b[\s!.?]*$/i;
const CODE = /```|^\s{4}\S|\b(?:function|class|def|import|const|let|SELECT|#include)\b/m;
const TRACE = /(?:Traceback \(most recent call last\)|at \S+ \(\S+:\d+:\d+\)|Exception in thread|panic:|Error: .+\n\s+at )/;

/** Deterministic complexity policy. Pure: no clock, no randomness, no I/O. */
export function classifyTask(input: RouteInput): { tier: ModelTier; score: number; reasons: string[] } {
  const text = input.text.trim();
  const reasons: string[] = [];
  let score = 0;
  const add = (points: number, reason: string) => { score += points; reasons.push(reason); };
  if (TRIVIAL.test(text)) return { tier: "fast", score: 0, reasons: ["short conversational reply"] };
  if (text.length > 4_000) add(3, "long request");
  else if (text.length > 800) add(1, "detailed request");
  if (HARDEST.test(text)) add(5, "hard-task keywords");
  else if (HARD.test(text)) add(3, "hard-leaning keywords");
  else if (MEDIUM.test(text)) add(2, "analysis or coding keywords");
  if (TRACE.test(text)) add(5, "stack trace");
  else if (CODE.test(text)) add(1, "code in the request");
  if ((input.attachments ?? 0) > 0) add(1, "attachments");
  if ((input.historyChars ?? 0) > 60_000) add(3, "long context");
  else if ((input.historyChars ?? 0) > 20_000) add(1, "substantial context");
  if (input.tools?.computer) add(2, "drives a computer");
  if (input.tools?.browser || input.tools?.connectors) add(1, "uses tools");
  const tier: ModelTier = score >= 5 ? "strong" : score >= 2 ? "standard" : "fast";
  if (!reasons.length) reasons.push("simple request");
  return { tier, score, reasons };
}

/** Pick the allowed model for this turn, with its cheaper fallback. */
export function routeModel(input: RouteInput, catalog: ModelRouteCatalog = modelRouteCatalog()): RouteDecision {
  const { tier, score, reasons } = classifyTask(input);
  const model = catalog[tier];
  const cheaper = MODEL_TIERS.slice(0, MODEL_TIERS.indexOf(tier)).reverse().map((candidate) => catalog[candidate]).find((candidate) => candidate !== model);
  return { tier, model, ...(cheaper ? { fallback: cheaper } : {}), score, reasons };
}

export interface RouteReceipt extends RouteDecision {
  at: number;
  threadId: string;
  /** Hashed account id from the credit ledger, never an email. */
  account?: string;
}

const RECENT_LIMIT = 200;
const recent: RouteReceipt[] = [];
let receiptFile: string | null = null;

export function setRouteReceiptFile(path: string | null): void { receiptFile = path; }

/** Record one routing decision: bounded in memory, appended to a JSONL file
 * the operator can reconcile against the credit ledger by thread id. */
export function recordRoute(receipt: RouteReceipt): void {
  recent.push(receipt);
  if (recent.length > RECENT_LIMIT) recent.shift();
  if (!receiptFile) return;
  try { appendFileSync(receiptFile, JSON.stringify(receipt) + "\n", { mode: 0o600 }); }
  catch { /* receipts are diagnostic; a full disk must not fail the turn */ }
}

export function recentRoutes(): RouteReceipt[] { return [...recent]; }
