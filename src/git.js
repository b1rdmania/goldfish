// Best-effort git repo detection for a project directory.
// Reads .git/config directly (no child process, no git dependency) and
// normalises the origin remote to a stable "host/owner/repo" string,
// e.g. "github.com/b1rdmania/goldfish". Returns null on any failure —
// project paths from Claude Code are decoded heuristically and may not exist.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export function repoForPath(projectPath) {
  if (!projectPath) return null;
  let config;
  try {
    config = readFileSync(join(projectPath, ".git", "config"), "utf8");
  } catch {
    return null;
  }
  // Find url = ... under [remote "origin"]; fall back to the first remote url.
  const sections = config.split(/^\[/m);
  const origin = sections.find((s) => s.startsWith(`remote "origin"`));
  const section = origin ?? sections.find((s) => s.startsWith("remote "));
  const url = section?.match(/^\s*url\s*=\s*(.+)$/m)?.[1]?.trim();
  if (!url) return null;
  return normaliseRemote(url);
}

export function normaliseRemote(url) {
  // git@github.com:owner/repo.git → github.com/owner/repo
  // https://github.com/owner/repo.git → github.com/owner/repo
  // ssh://git@host/owner/repo → host/owner/repo
  let m = url.match(/^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/i);
  if (m) return `${m[1]}/${m[2]}`;
  m = url.match(/^(?:[^@]+@)?([^:/]+):(.+?)(?:\.git)?\/?$/);
  if (m) return `${m[1]}/${m[2]}`;
  return null;
}
