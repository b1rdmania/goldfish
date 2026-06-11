// Optional semantic search via a local embedding model (opt-in).
//
// `goldfish embed` calls a local Ollama instance (default model
// nomic-embed-text) for every message that doesn't have an embedding yet and
// stores vectors in the embeddings sidecar table. `goldfish search --semantic`
// (and the MCP `semantic` flag) then ranks by cosine similarity.
//
// This is the ONLY code in goldfish that makes a network call, it is
// localhost-only, and nothing happens unless you run `goldfish embed` first —
// keyword search never touches it.

const OLLAMA_URL = process.env.GOLDFISH_OLLAMA_URL || "http://127.0.0.1:11434";
const MODEL = process.env.GOLDFISH_EMBED_MODEL || "nomic-embed-text";
const BATCH = 32;

async function embedTexts(texts) {
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, input: texts }),
  });
  if (!res.ok) throw new Error(`Ollama returned ${res.status} ${res.statusText}`);
  const { embeddings } = await res.json();
  return embeddings;
}

export function embeddingsAvailable(db) {
  return (
    db.prepare(`SELECT COUNT(*) AS n FROM embeddings`).get().n > 0
  );
}

export async function embedAll(db, { onProgress = () => {} } = {}) {
  const pending = db
    .prepare(
      `SELECT m.id, m.content FROM messages m
       LEFT JOIN embeddings e ON e.message_id = m.id
       WHERE e.message_id IS NULL AND length(m.content) > 0`
    )
    .all();
  if (!pending.length) return 0;

  const ins = db.prepare(
    `INSERT OR REPLACE INTO embeddings (message_id, model, vector) VALUES (?, ?, ?)`
  );
  let done = 0;
  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);
    // Long messages are truncated for embedding only; stored content is untouched.
    const vectors = await embedTexts(batch.map((m) => m.content.slice(0, 8000)));
    batch.forEach((m, j) => {
      ins.run(m.id, MODEL, Buffer.from(new Float32Array(vectors[j]).buffer));
    });
    done += batch.length;
    onProgress(done, pending.length);
  }
  return done;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// Hybrid ranking: reciprocal rank fusion of BM25 (keyword) and cosine
// (semantic) result lists. Either list alone misses things the other finds;
// RRF needs no score normalisation between the two.
export async function hybridSearch(db, query, { limit = 20, scope = {} } = {}) {
  const { searchTranscripts } = await import("./search.js");
  const k = 60; // standard RRF constant
  const keyword = searchTranscripts(db, query, { limit: limit * 2, scope });
  const semantic = await semanticSearch(db, query, { limit: limit * 2, scope });
  const fused = new Map();
  const add = (rows, kind) =>
    rows.forEach((r, i) => {
      const key = r.message_id;
      const entry = fused.get(key) ?? { ...r, rrf: 0, matched: [] };
      entry.rrf += 1 / (k + i + 1);
      entry.matched.push(kind);
      fused.set(key, entry);
    });
  add(keyword, "keyword");
  add(semantic, "semantic");
  return [...fused.values()]
    .sort((a, b) => b.rrf - a.rrf)
    .slice(0, limit)
    .map(({ rrf, rank, score, vector, ...rest }) => ({ ...rest, score: rrf }));
}

export async function semanticSearch(db, query, { limit = 20, scope = {} } = {}) {
  const [qv] = await embedTexts([query]);
  const q = new Float32Array(qv);

  // Brute-force cosine over all in-scope vectors. Fine at personal-history
  // scale (tens of thousands of messages); revisit if that assumption breaks.
  const scopeClauses = [];
  const params = [];
  if (scope.sources?.length) {
    scopeClauses.push(`c.source IN (${scope.sources.map(() => "?").join(",")})`);
    params.push(...scope.sources);
  }
  if (scope.projects?.length) {
    scopeClauses.push(`(${scope.projects.map(() => "c.project LIKE '%' || ? || '%'").join(" OR ")})`);
    params.push(...scope.projects);
  }
  if (scope.repos?.length) {
    scopeClauses.push(`(${scope.repos.map(() => "c.repo LIKE '%' || ? || '%'").join(" OR ")})`);
    params.push(...scope.repos);
  }
  if (scope.since) {
    scopeClauses.push(`c.updated_at >= ?`);
    params.push(scope.since);
  }
  const where = scopeClauses.length ? `WHERE ${scopeClauses.join(" AND ")}` : "";

  const rows = db
    .prepare(
      `SELECT e.vector, m.id AS message_id, m.role, substr(m.content, 1, 300) AS snippet,
              c.id AS conversation_id, c.source, c.title, c.project, c.repo, c.updated_at
       FROM embeddings e
       JOIN messages m ON m.id = e.message_id
       JOIN conversations c ON c.id = m.conversation_id
       ${where}`
    )
    .all(...params);

  return rows
    .map((r) => {
      const v = new Float32Array(r.vector.buffer, r.vector.byteOffset, r.vector.byteLength / 4);
      const { vector, ...rest } = r;
      return { ...rest, score: cosine(q, v) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
