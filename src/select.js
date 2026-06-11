// Ingest-time selection: bound what enters the database at all.
// Serve-time scoping (src/server.js) limits what an agent can see;
// this limits what goldfish remembers in the first place. Personal chats
// you never ingest can never leak, whatever happens downstream.
//
//   goldfish ingest claude export.json --match enticeable --match goldfish
//   goldfish ingest claude export.json --exclude therapy --since 90d --dry-run
//
// match/exclude are case-insensitive substrings on the conversation title;
// project matches the project path (claude-code only); since cuts on
// updated_at. --dry-run previews the selection without storing anything.

export function buildFilter({ since = null, match = [], exclude = [], project = [] } = {}) {
  const lc = (s) => (s || "").toLowerCase();
  return (meta) => {
    if (since && (!meta.updated_at || meta.updated_at < since)) return false;
    if (match.length && !match.some((m) => lc(meta.title).includes(lc(m)))) return false;
    if (exclude.length && exclude.some((m) => lc(meta.title).includes(lc(m)))) return false;
    if (project.length && !project.some((p) => lc(meta.project).includes(lc(p)))) return false;
    return true;
  };
}
