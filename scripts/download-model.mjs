// Downloads the embedding model Xenova/multilingual-e5-small (q8 ONNX) into <dir>, in the
// layout transformers.js reads offline: <dir>/Xenova/multilingual-e5-small/{config.json,…,onnx/model_quantized.onnx}.
// The revision is pinned and every file is checked against its SHA-256, so the image build is
// reproducible. Files already present with the right hash are skipped.
//
// Usage: node scripts/download-model.mjs /app/models
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MODEL = 'Xenova/multilingual-e5-small';
const REVISION = '761b726dd34fb83930e26aab4e9ac3899aa1fa78';
const FILES = {
  'config.json': 'cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1',
  'special_tokens_map.json': 'd05497f1da52c5e09554c0cd874037a083e1dc1b9cfd48034d1c717f1afc07a7',
  'tokenizer_config.json': 'a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b',
  'tokenizer.json': '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39',
  'onnx/model_quantized.onnx': 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193',
};
const ATTEMPTS = 3;
const FETCH_TIMEOUT_MS = 120_000;

async function sha256Of(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function download(url, target, expected) {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok || !response.body) throw new Error(`${url}: HTTP ${response.status}`);
  const hash = createHash('sha256');
  const tee = new Transform({
    transform(chunk, _enc, done) {
      hash.update(chunk);
      done(null, chunk);
    },
  });
  const partial = `${target}.partial`;
  await pipeline(Readable.fromWeb(response.body), tee, createWriteStream(partial));
  const actual = hash.digest('hex');
  if (actual !== expected) {
    await rm(partial, { force: true });
    throw new Error(`${url}: sha256 ${actual}, expected ${expected}`);
  }
  await rename(partial, target);
}

async function fetchFile(root, file, expected) {
  const target = join(root, MODEL, file);
  if ((await exists(target)) && (await sha256Of(target)) === expected) {
    console.log(`ok (cached) ${file}`);
    return;
  }
  await mkdir(dirname(target), { recursive: true });
  const url = `https://huggingface.co/${MODEL}/resolve/${REVISION}/${file}`;
  const attempt = async (n) => {
    try {
      await download(url, target, expected);
    } catch (error) {
      if (n >= ATTEMPTS) throw error;
      console.warn(`retry ${n}/${ATTEMPTS - 1} ${file}: ${error.message}`);
      await attempt(n + 1);
    }
  };
  await attempt(1);
  console.log(`ok ${file}`);
}

const root = process.argv[2];
if (!root) {
  console.error('Usage: node scripts/download-model.mjs <dir>');
  process.exit(2);
}
await Promise.all(Object.entries(FILES).map(([file, expected]) => fetchFile(root, file, expected)));
console.log(`${MODEL}@${REVISION} is in ${join(root, MODEL)}`);
