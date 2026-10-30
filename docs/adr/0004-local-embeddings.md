# 0004. Local embeddings

## Context

Hybrid search (FTS + vector) requires embeddings. The service must work without paid external services, keys and, once the image is built, without internet access. Skills are written in Russian and English.

## Decision

Embeddings are computed locally via `transformers.js` with the `Xenova/multilingual-e5-small` model (dimension 384, prefixes `passage: ` for documents and `query: ` for queries). The model is baked into the Docker image. Behind the `Embedder` port there is a second adapter — OpenAI-compatible HTTP — for those who want an external model. Ranking is Reciprocal Rank Fusion over FTS and vector results.

## Consequences

- No external dependencies or keys; skill content stays private.
- The image is larger, cold start is slower, and computation loads the server CPU.
- Changing the model requires a full reindex (a command is provided) and a vector dimension migration.
- Quality is limited by a small model; the port allows replacing it without touching the domain.
