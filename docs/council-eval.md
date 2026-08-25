# LLM Council — write-time consolidation eval

**Question:** does the 3-stage LLM Council (≈`2N+1` model calls) produce better
long-term memory than a single-pass write — enough to justify its cost?

## Method
`src/council/eval.ts` runs a golden set of ≥5 contested-write cases through **both**
paths and scores each output by the fraction of facts the *correct* consolidated
note must retain (`scoreOutput`). The failure mode under test: a naive single-pass
write takes the **incoming** text and silently **drops still-valid facts** from the
existing note. A consolidating council should retain both. Run it via the executable
harness in `test/council/eval.test.ts`.

## Result (simulated models)
| | single-pass | council | delta |
|---|---|---|---|
| avg retention score (5 cases) | **0.70** | **1.00** | **+0.30 (+30%)** |

Council never scored worse; it won on the three *retention* cases and tied on the
two where the incoming text already carried the full answer (new fact / value
correction). Verdict on this set: **council +30%**.

## Honesty caveat (read this)
These numbers use **simulated** council members (a deterministic "merge existing +
incoming" stand-in), because the real multi-model path runs through the AI Gateway
inference client that lands in **F3**. So this proves:
1. the eval **harness** is real and the consolidation **mechanism** retains facts a
   naive overwrite loses, **and**
2. council is **off by default** and costs nothing until explicitly enabled.

It does **not** yet prove real frontier models beat single-pass enough to justify
≈5× the tokens. That decision — enable paid council or not — is deferred until the
harness is re-run against real models post-F3, with the per-run cost (already logged
by `consolidate`) weighed against the measured delta. Until then: **council stays
OFF**.
