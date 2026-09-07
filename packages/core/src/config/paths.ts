import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

/**
 * Local-first storage layout.
 *
 * Project files, configuration and turn/session logs are stored locally under
 * the application home. A crash leaves a readable, replayable on-disk trail.
 *
 * Secrets never live here: Microsoft tokens are held by the Azure CLI's own
 * OS-backed cache (see entra/entra-auth.ts) and the GitHub credential by the
 * Copilot runtime under `COPILOT_HOME`, so credentials and per-device state stay
 * local and out of any sync surface.
 */
export interface AppPaths {
  readonly root: string;
  readonly config: string;
  readonly sessions: string;
  readonly turns: string;
  readonly skills: string;
  readonly skillProposals: string;
  readonly memories: string;
  readonly jobs: string;
  readonly orchestration: string;
  readonly audit: string;
  readonly logs: string;
  readonly project: string;
  readonly knowledge: string;
  /** Demo material the app writes for itself, and deletes on request. */
  readonly samples: string;
  /** Recordings, transcripts and generated notes, one directory per meeting. */
  readonly meetings: string;
  /**
   * Skill recordings: one directory per capture, holding the event log, the
   * screen frames, the narration and everything derived from them.
   *
   * Kept out of the bound project, unlike a meeting's audio. A meeting
   * recording is a work artifact someone will want to find beside the deck it
   * produced; a skill recording is raw evidence of what a person's screen
   * looked like, and putting that in a directory that may be synced or shared
   * is a different decision than the user made when they pressed record.
   */
  readonly recordings: string;
  /** External binaries `pnpm prepare:ffmpeg` downloads. Safe to delete. */
  readonly tools: string;
  /**
   * Scratch PNGs from the native Office renderer. Each is read once and
   * deleted; anything left behind is a crashed render. Safe to delete.
   */
  readonly renders: string;
  /**
   * The snapshot the My IQ MCP server reads.
   *
   * Its own directory rather than a file under `config` because it is the one
   * thing here written *for another program to read*: a client spawns the
   * server with no knowledge of this app, and pointing it at a directory that
   * also holds connection settings would widen what a bug in it could reach.
   */
  readonly myiq: string;
}

export function resolveAppPaths(root?: string): AppPaths {
  const base = root ?? process.env["IQ_HOME"] ?? join(homedir(), ".iq-compiler");
  return {
    root: base,
    config: join(base, "config"),
    sessions: join(base, "sessions"),
    turns: join(base, "turns"),
    skills: join(base, "skills"),
    skillProposals: join(base, "skills", ".proposals"),
    memories: join(base, "memories"),
    jobs: join(base, "jobs"),
    orchestration: join(base, "orchestration"),
    audit: join(base, "audit"),
    logs: join(base, "logs"),
    project: join(base, "project"),
    // Derived index only: safe to delete, rebuilt from the project.
    knowledge: join(base, "knowledge"),
    samples: join(base, "samples"),
    meetings: join(base, "meetings"),
    recordings: join(base, "recordings"),
    tools: join(base, "tools"),
    renders: join(base, "renders"),
    myiq: join(base, "myiq"),
  };
}

export function ensureAppPaths(paths: AppPaths): void {
  for (const dir of Object.values(paths)) {
    mkdirSync(dir, { recursive: true });
  }
}
