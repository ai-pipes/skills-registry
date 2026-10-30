# 0005. Relevance floor for vector search

## Context

Vector candidates were selected without any cut-off: `order by embedding <=> q limit 50` returns the whole index in some order. On top of that, the score was normalized to the best result, so the first result always got `1.0`. As a result, search never answered "nothing found": for "borscht recipe" the agent got code-review with a score of 1.0.

## Decision

1. A vector candidate passes only if its cosine similarity is at least the threshold τ: `1 - (embedding <=> q) >= τ`. The threshold is set by the `SEARCH_MIN_SIMILARITY` variable (0..1), **0.80** by default. Full-text candidates are unchanged: a word match is evidence in itself.
2. The score is no longer normalized to the best result. Formula: `score = rrf / (2 / (k + 1))`, where `rrf = Σ 1/(k + rank)` over the lists, `k = 60`. The divisor is fixed (two lists: FTS and vector) and does not depend on whether the embedder is ready: a hit from only one list gets at most `0.5`, with the model ready or not; `1` means first place in both lists. The score is always in `(0, 1]`. This contract is described in the `description` of the `search_skills` MCP tool.
3. If there is neither a text match nor a vector above τ, the result is empty.

## Measuring τ

Model `Xenova/multilingual-e5-small` (q8, as in the image), prefixes `query: ` / `passage: `. The passage text is as in the index: `name\ndescription\nbody`. A corpus of six skills:

- code-review (EN);
- pdf-forms (EN);
- db-migrations (RU);
- commit-messages (RU);
- docker-deploy (EN);
- excel-reports (RU).

Measurement script: embed each query, compute cosine against all six passages.

Queries marked **[ru]** were run in Russian; the table shows their English translation, and the numbers are for the Russian originals.

Relevant queries. The "Similarity to target" column is the similarity to the intended skill; "Best other" is the highest similarity to any other skill.

| Query                                     | Target skill    | Similarity to target | Best other |
| ----------------------------------------- | --------------- | -------------------: | ---------: |
| [ru] code review                          | code-review     |               0.8201 |     0.7821 |
| [ru] check a pull request for errors      | code-review     |               0.8270 |     0.8271 |
| review my code changes                    | code-review     |               0.8941 |     0.7917 |
| [ru] fill in a PDF form                   | pdf-forms       |               0.8558 |     0.7966 |
| extract fields from a pdf form            | pdf-forms       |               0.9195 |     0.7731 |
| [ru] database migration                   | db-migrations   |               0.8780 |     0.7826 |
| add an index to a postgres table safely   | db-migrations   |               0.8244 |     0.7994 |
| [ru] write a commit message               | commit-messages |               0.8920 |     0.7941 |
| git commit message format                 | commit-messages |               0.8382 |     0.7918 |
| [ru] deploy to docker                     | docker-deploy   |               0.8073 |     0.7838 |
| deploy with docker compose                | docker-deploy   |               0.9074 |     0.7762 |
| [ru] pivot table in excel                 | excel-reports   |               0.8676 |     0.7847 |
| make a spreadsheet chart                  | excel-reports   |               0.8240 |     0.8183 |
| pdf                                       | pdf-forms       |               0.8255 |     0.7839 |
| docker                                    | docker-deploy   |               0.8503 |     0.7954 |
| excel                                     | excel-reports   |               0.8561 |     0.7723 |
| [ru] migrations                           | db-migrations   |               0.8702 |     0.7796 |
| [ru] commit                               | commit-messages |               0.8703 |     0.8047 |
| [ru] review                               | code-review     |               0.7674 |     0.7682 |
| [ru] find bugs in code                    | code-review     |               0.7938 |     0.7980 |
| [ru] roll out a service to a server       | docker-deploy   |               0.7839 |     0.7884 |

Irrelevant queries, maximum similarity to any skill:

| Query                          | Max similarity | Query                   | Max similarity |
| ------------------------------ | -------------: | ----------------------- | -------------: |
| [ru] borscht recipe            |         0.7810 | [ru] how to brew coffee |         0.7770 |
| [ru] weather in Moscow tomorrow |        0.7438 | [ru] commuter train timetable |   0.7804 |
| how to train a puppy           |         0.7853 | symptoms of the flu     |         0.8123 |
| [ru] best beaches in Thailand  |         0.7474 | [ru] how much is an iPhone |      0.7465 |
| football match results         |         0.7205 | [ru] hi                 |         0.7739 |
| [ru] Pushkin's poems about love |        0.7629 | hello                   |         0.7647 |
| [ru] buy a plane ticket        |         0.7845 | [ru] kitties            |         0.8123 |
| quantum physics lecture        |         0.7586 | [ru] game of thrones    |         0.7601 |

What the measurements show:

- With e5-small, similarities are squeezed into a narrow 0.72–0.92 range, and the distributions partly overlap.
- 14 of 16 irrelevant queries are at most 0.7853.
- 18 of 21 relevant queries are at least 0.8073.
- Between these values there is a tight gap; τ = 0.80 sits in its middle.

The cost of the choice at τ = 0.80:

- 2 of 16 irrelevant queries pass ("symptoms of the flu" and "[ru] kitties", both 0.8123);
- 3 of 21 vague relevant queries are lost ("[ru] review", "[ru] find bugs in code", "[ru] roll out a service to a server", 0.767–0.794).

Single-word queries are more often found by full-text search if the word is in the description. At τ = 0.815, 0 of 16 irrelevant queries pass, but 4 of 21 relevant ones are lost, and "[ru] code review" (0.8201) is left almost at the boundary.

Example smoke test: skills code-review and pdf-forms, queries "[ru] code review", "[ru] fill in a PDF form" and "[ru] borscht recipe". The same texts are checked by an integration test on the real model (`test/search/search-real-model.int.test.ts`).

## Embedding recovery

A document that cannot be indexed (for example, too long or "poisonous" for the model) must not block the sweep. The column `search.documents.embed_failed_at` is set on error; the sweep takes only documents with `embedding is null and (embed_failed_at is null or embed_failed_at < now() - interval '1 hour')`, and on a document error it marks the document and moves on to the next one. Successful indexing with an embedding clears the field. The mark is set only for an isolated error (the next document succeeds). After three errors in a row, the sweep embeds the reference text `passage: health probe`: if the probe succeeds, these are "poisonous" documents (all three are marked and the sweep continues); if not, it is an embedder failure (stop, nothing is marked). Candidates are ordered by `embed_failed_at nulls first, slug`, so never-tried documents come before retries. The sweep also stops when its 30 s budget is exhausted. Sweep limits are unchanged: batch of 20, no more than once a minute.

## Consequences

- For a clearly off-topic query, search answers "nothing found". The agent does not get junk with a score of 1.0.
- The threshold is calibrated for e5-small. For a different model (`EMBEDDER=openai-compatible`) it has to be re-tuned via `SEARCH_MIN_SIMILARITY`.
- The threshold can be loosened for recall (≈0.78) or tightened for precision (≈0.82) without rebuilding.
- Vague queries that share no words with a skill may find nothing. This is a deliberate trade-off.
