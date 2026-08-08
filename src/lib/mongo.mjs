/**
 * MongoDB connection handling for the takatime collection.
 *
 * ---------------------------------------------------------------------------
 * RUNTIME CONSTRAINT — READ BEFORE CHANGING THE DEPLOY TARGET
 * ---------------------------------------------------------------------------
 * The `mongodb` npm driver CANNOT run on Cloudflare Workers. It opens raw TCP
 * via `node:net` and wraps it in `node:tls`, and resolves `mongodb+srv://` hosts
 * through `node:dns`. Workers provides no usable equivalent: `node:tls` and
 * `node:dns` are only partially implemented, and the SRV/TXT lookups that
 * `mongodb+srv://` requires are not among the implemented parts.
 *
 * This is not a configuration problem that `nodejs_compat` fixes. Verified by
 * running the built Worker locally, where the route fails at module load —
 * before any query is attempted — with:
 *
 *     Error: No such module "chunks/timers"
 *
 * So this module (and anything importing it) only works where a real Node
 * runtime is present:
 *
 *     WORKS      `astro dev`, `node scripts/generate-stats.mjs`, GitHub Actions
 *     DOES NOT   the deployed Cloudflare Worker
 *
 * `scripts/generate-stats.mjs` runs in GitHub Actions on Node, which is why the
 * static `public/coding-stats.json` path is the one that actually feeds the site.
 *
 * ---------------------------------------------------------------------------
 * CLIENT CACHING
 * ---------------------------------------------------------------------------
 * The client is cached at module scope and the connection is pooled, which is
 * the correct pattern under Node: it survives across requests in one process and
 * avoids paying TLS + auth handshakes per request.
 *
 * This is deliberately NOT gated behind a "is this Workers?" check. On Workers
 * the import fails long before caching could matter, so a guard would only add
 * dead code that implies the route might otherwise work there.
 */

import { MongoClient } from 'mongodb';

import { COLLECTION_NAME, DB_NAME } from './takatime-stats.mjs';

/** @type {Promise<MongoClient> | null} */
let clientPromise = null;

/**
 * Connected client, reused across calls in the same process.
 *
 * The PROMISE is cached rather than the resolved client, so concurrent callers
 * during startup share one in-flight connection instead of racing to open
 * several. A failed connection clears the cache so the next call can retry
 * rather than being stuck with a permanently rejected promise.
 */
export function getClient(uri) {
  if (!uri) throw new Error('MONGO_URI is not set');
  if (!clientPromise) {
    clientPromise = new MongoClient(uri).connect().catch((err) => {
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

/** The `takatime.logs` collection, via the cached client. */
export async function getLogsCollection(uri) {
  const client = await getClient(uri);
  return client.db(DB_NAME).collection(COLLECTION_NAME);
}

/** Close the cached client. For one-shot scripts; never call this per request. */
export async function closeClient() {
  if (!clientPromise) return;
  const pending = clientPromise;
  clientPromise = null;
  await (await pending).close();
}
