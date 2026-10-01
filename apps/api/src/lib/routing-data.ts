// SPDX-License-Identifier: Apache-2.0
/**
 * Routing samples from council runs: for each question where members
 * converged, which models held the council's position and which did not.
 * @nexus/llm-router's KNN, MLP, SVM and MF routers train on them, and only
 * once an account has asked MIN_ROUTING_QUESTIONS such questions.
 */
import { trainRouters, type RoutingSample, type TrainedRouters } from "@nexus/llm-router";

import { PersistentStore } from "./persistent-store.js";

export const MIN_ROUTING_QUESTIONS = 30;
const MAX_SAMPLES = 3000;

const store = new PersistentStore<{ samples: RoutingSample[] }>("routing-samples");
let loaded: Promise<void> | null = null;
const ready = () => (loaded ??= store.load().catch(() => undefined));

const trained = new Map<string, { size: number; routers: TrainedRouters | null }>();

/** Record one council question. Skipped when fewer than two members share a position. */
export async function recordCouncilRun(
  owner: string,
  question: string,
  answers: { model: string; agreed: boolean }[],
): Promise<void> {
  if (answers.filter((a) => a.agreed).length < 2) return;
  await ready();
  const samples = [
    ...(store.get(owner)?.samples ?? []),
    ...answers.map((a) => ({ query: question.slice(0, 2000), ...a })),
  ].slice(-MAX_SAMPLES);
  store.set(owner, { samples });
}

export async function learnedRouting(owner: string, query?: string) {
  await ready();
  const samples = store.get(owner)?.samples ?? [];
  const questions = new Set(samples.map((s) => s.query)).size;
  const models = [...new Set(samples.map((s) => s.model))];
  const active = questions >= MIN_ROUTING_QUESTIONS && models.length >= 2;
  let routers: TrainedRouters | null = null;
  if (active) {
    const cached = trained.get(owner);
    routers = cached?.size === samples.length ? cached.routers : trainRouters(samples);
    trained.set(owner, { size: samples.length, routers });
  }
  return {
    questions,
    needed: MIN_ROUTING_QUESTIONS,
    models,
    active: active && routers !== null,
    ...(routers && query?.trim() ? { route: routers.route(query) } : {}),
  };
}
