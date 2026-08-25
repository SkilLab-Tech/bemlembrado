# Retrieval-relevance eval

`src/eval/retrieval.ts` is a golden-set eval harness for **search relevance** — the
complement to the write-time consolidation eval (`docs/council-eval.md`).

## What it measures
For each golden case (a small corpus + a query + ground-truth relevant memory ids) it
computes the standard IR metrics against a ranking:

- **precision@k** — of the top-k retrieved, the fraction that are relevant.
- **recall** — the fraction of relevant memories retrieved anywhere in the ranking.
- **MRR** — mean reciprocal rank of the first relevant hit.

It aggregates across the golden set into `{ meanPrecisionAtK, meanRecall, mrr }`.

## Honesty caveat (same as the council eval)
The harness is real and executable, but the **scores are only as real as the retriever
you pass in**. Unit tests (`test/eval/retrieval.test.ts`) exercise the harness with a
deterministic fake retriever to prove the metrics are correct — they do NOT measure real
semantic relevance.

Real numbers require live embeddings + Vectorize (no local sim in the pool). To produce
them, run `runRetrievalEval` against a **staging retriever** that:

1. seeds each case's `corpus` into its `namespace` via `POST /v1/memory`, then
2. returns the ranked ids from `POST /v1/search` for the case's `query`.

## Selectivity dimension
Most golden cases are small corpora where the relevant memory is lexically obvious. The
`selectivity-quota` case is different: one relevant fact buried in six distractors that
all share the query's vocabulary (turn / plan / month / quota / limit). It exists to
separate a *discriminating* retriever from an *indiscriminate* one — a retriever that
returns the whole corpus still scores recall = 1 and MRR = 1, but **precision@k** drops
to `1/k`. Precision is the metric that carries the selectivity signal; recall and MRR
alone would call the indiscriminate retriever perfect. `test/eval/retrieval.test.ts`
pins this with a dump-everything fake retriever.

## Retrieval-v2 (B1/B2) integration
The write and search paths this harness scores against changed in retrieval-v2:
- **B1 (write path):** `POST /v1/memory` is now D1-first — the row is written with
  `vector_ok = 0`, the Vectorize upsert follows, then `vector_ok` is set to 1. A staging
  seeder built on this endpoint therefore makes each case's corpus durable in D1 even if
  the embedding upsert is retried, so the golden corpus is stable across re-runs.
- **B2 (search path):** `POST /v1/search` now returns honest budget accounting —
  `{ hits, requested, returned, dropped }` — where `dropped` counts hits that resolved to
  an orphaned/missing D1 row and were excluded. A staging retriever should read `hits`
  for the ranking **and** record `dropped` as a second retrieval-quality signal: a
  healthy index has `dropped = 0`; a nonzero `dropped` means the vector index and D1 have
  drifted, which corrupts any precision/recall number computed on top of it. Check it
  before trusting the aggregate metrics.

**Real numbers are still deferred, not fabricated.** No aggregate precision/recall/MRR is
committed to this repo, because producing an honest one requires a seeded staging
Vectorize index (live bge-m3 embeddings — there is no local sim in the workerd pool). The
harness + golden set + staging recipe above are the deliverable; the numbers come from
running it against staging, and are recorded there, not hard-coded here.

## A/B rig for the AutoRAG decision
This is also the comparison rig for `docs/decisions/ai-search-autorag.md` (DEFER, keep
Vectorize). To revisit that decision, run the **same golden set** through two retrievers
— one backed by Vectorize, one by an AutoRAG/AI-Search instance — and compare the
aggregate metrics. A retriever swap is the only change; the golden set stays fixed, so
the comparison is apples-to-apples.
