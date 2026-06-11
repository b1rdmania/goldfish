// Secret redaction — runs at ingest time, before anything touches the database.
// High-confidence patterns only (gitleaks-style): better to miss an oddly
// formatted secret than to mangle ordinary prose. Counts are tracked per kind;
// matched content is never logged or returned.
//
// Disable with `goldfish ingest ... --no-redact` or GOLDFISH_NO_REDACT=1.

const mark = (kind) => `[REDACTED:${kind}]`;

// Order matters where prefixes overlap (anthropic-key before openai-key).
const PATTERNS = [
  {
    kind: "private-key",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY( BLOCK)?-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY( BLOCK)?-----/g,
  },
  { kind: "aws-access-key-id", re: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g },
  { kind: "github-token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g },
  { kind: "github-pat", re: /\bgithub_pat_[A-Za-z0-9_]{50,}\b/g },
  { kind: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { kind: "openai-key", re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/g },
  { kind: "stripe-key", re: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { kind: "stripe-webhook-secret", re: /\bwhsec_[A-Za-z0-9]{24,}\b/g },
  { kind: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "gitlab-token", re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { kind: "npm-token", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: "sendgrid-key", re: /\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{40,}\b/g },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
];

// Credential-in-URL: keep scheme/user/host searchable, redact only the password.
const CONNECTION_STRING =
  /\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?|https?|ftp):\/\/([^\s:@/]+):([^\s@/]+)@/g;

// key = "value" assignments: keep the key name searchable, redact the value.
const ASSIGNMENT =
  /\b(api[_-]?key|apikey|secret[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token|password|passwd)(\s*[:=]\s*)(["'])([^"'\s]{8,})\3/gi;

let enabled = !process.env.GOLDFISH_NO_REDACT;
const totals = Object.create(null);

export function setRedaction(on) {
  enabled = on;
}

export function redactionTotals() {
  return { ...totals };
}

// Re-run redaction over an existing database (data ingested before
// redaction existed, or with --no-redact). The FTS update trigger keeps the
// search index in sync. Returns the number of messages changed.
export function redactDatabase(db, { dryRun = false } = {}) {
  const rows = db.prepare(`SELECT id, content FROM messages`).all();
  const upd = db.prepare(`UPDATE messages SET content = ? WHERE id = ?`);
  let changed = 0;
  db.exec("BEGIN");
  try {
    for (const r of rows) {
      const out = redactSecrets(r.content);
      if (out !== r.content) {
        changed++;
        if (!dryRun) upd.run(out, r.id);
      }
    }
    db.exec(dryRun ? "ROLLBACK" : "COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return changed;
}

export function redactSecrets(text) {
  if (!enabled || !text) return text;
  let out = text;
  for (const { kind, re } of PATTERNS) {
    out = out.replace(re, () => {
      totals[kind] = (totals[kind] || 0) + 1;
      return mark(kind);
    });
  }
  out = out.replace(CONNECTION_STRING, (_, scheme, user) => {
    totals["connection-string-password"] = (totals["connection-string-password"] || 0) + 1;
    return `${scheme}://${user}:${mark("password")}@`;
  });
  out = out.replace(ASSIGNMENT, (_, key, sep, quote) => {
    totals["key-assignment"] = (totals["key-assignment"] || 0) + 1;
    return `${key}${sep}${quote}${mark("secret")}${quote}`;
  });
  return out;
}
