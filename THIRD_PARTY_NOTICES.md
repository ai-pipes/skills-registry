# Third-party notices

Skills Registry is licensed under the MIT License (see [LICENSE](./LICENSE)). The Docker image and the
web bundle also ship third-party components under their own licenses. npm dependencies keep their
license files in `node_modules`; this file lists the components worth calling out.

## Bundled in the Docker image

| Component                                                                                                                                 | License           | Notes                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Xenova/multilingual-e5-small](https://huggingface.co/Xenova/multilingual-e5-small) (revision `761b726dd34fb83930e26aab4e9ac3899aa1fa78`) | MIT               | Quantized ONNX port of [intfloat/multilingual-e5-small](https://huggingface.co/intfloat/multilingual-e5-small) (MIT). Downloaded at build time by `scripts/download-model.mjs`. |
| [@huggingface/transformers](https://github.com/huggingface/transformers.js)                                                               | Apache-2.0        | Runs the embedding model.                                                                                                                                                       |
| [sharp](https://github.com/lovell/sharp)                                                                                                  | Apache-2.0        | Transitive dependency of `@huggingface/transformers`.                                                                                                                           |
| [libvips](https://github.com/libvips/libvips) (`@img/sharp-libvips-*`)                                                                    | LGPL-3.0-or-later | Prebuilt shared library used by `sharp`, dynamically linked. Source: https://github.com/libvips/libvips.                                                                        |

## Bundled in the web UI

| Component                                                             | License                   | Notes                                         |
| --------------------------------------------------------------------- | ------------------------- | --------------------------------------------- |
| [Inter](https://github.com/rsms/inter) (`@fontsource-variable/inter`) | SIL Open Font License 1.1 | Served from the bundle, no external requests. |

## Run alongside (not redistributed)

| Component                                                                                | License            | Notes                                                   |
| ---------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------- |
| [pgvector/pgvector](https://github.com/pgvector/pgvector) image (Postgres 17 + pgvector) | PostgreSQL License | Pulled by `docker-compose.yml` as a separate container. |
