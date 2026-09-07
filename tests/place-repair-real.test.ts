import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canHoldConversation, samePlace, type SessionPlace } from "@iq/shared";
import { SessionRepo } from "../packages/core/src/runtime/sessions/fs-repo.js";
import { SessionsService } from "../packages/core/src/runtime/sessions/sessions.js";
import type { SessionsDeps } from "../packages/core/src/runtime/sessions/sessions.js";
import { TurnRepo } from "../packages/core/src/runtime/turns/fs-repo.js";
import { ensureAppPaths, resolveAppPaths } from "../packages/core/src/config/paths.js";

/**
 * The repair, run against a real profile.
 *
 * Fixtures are written by whoever is fixing the bug, which means they encode
 * what that person already believed. This one reads the developer's own
 * `~/.iq-compiler`, copies it somewhere disposable, and folds it — so the
 * claim "the deck conversation now opens on Office" is made about the data
 * that was actually wrong rather than about a reconstruction of it.
 *
 * Skipped when there is no profile, which is every CI machine and every fresh
 * clone. It asserts properties rather than specific titles for the same
 * reason: another developer's history is not this one's.
 */
const HOME = join(homedir(), ".iq-compiler");
const HAS_PROFILE = existsSync(join(HOME, "sessions"));

describe.skipIf(!HAS_PROFILE)("the place repair, against a real profile", () => {
  it("derives a place for every conversation, and only showable ones", async () => {
    const root = mkdtempSync(join(tmpdir(), "iq-real-"));
    try {
      // Copies, always: this test must not be able to modify the profile it
      // is reading, however it fails. Only the two directories the fold
      // touches — a whole profile carries a browser profile and a Python venv,
      // and copying those takes longer than the test is allowed to run.
      const paths = resolveAppPaths(root);
      await ensureAppPaths(paths);
      cpSync(join(HOME, "sessions"), paths.sessions, { recursive: true });
      if (existsSync(join(HOME, "turns"))) {
        cpSync(join(HOME, "turns"), paths.turns, { recursive: true });
      }
      const repo = new SessionRepo(paths);
      const service = new SessionsService({
        paths,
        sessionRepo: repo,
        turnRepo: new TurnRepo(paths),
        logger: {
          info: () => undefined,
          warn: () => undefined,
          error: () => undefined,
          debug: () => undefined,
        },
        publishIndex: () => undefined,
        // Historic turn logs recorded our own families correctly — it is the
        // live permission request that arrives as `copilot.custom-tool` — so
        // the repair's `?? call.family` fallback is what does the work here.
        toolRegistry: { familyOf: () => null },
      } as unknown as SessionsDeps);

      const before = await repo.list();
      await service.placeExistingConversations();
      const after = await repo.list();

      const interactive = after.filter((row) => row.origin === "interactive");
      expect(interactive.length).toBeGreaterThan(0);

      for (const summary of interactive) {
        // Every conversation now has an answer, so none of them will be
        // re-derived on the next launch.
        expect(summary.placeKnown, summary.title).toBe(true);
        // And every answer is a view the shell can actually enter.
        expect(canHoldConversation(summary.place), summary.title).toBe(true);
      }

      // The point of the exercise: at least one conversation's place changed,
      // because the navigation records the old build wrote no longer decide.
      const moved = interactive.filter((row) => {
        const was = before.find((old) => old.id === row.id);
        return was !== undefined && !samePlace(was.place, row.place);
      });
      // eslint-disable-next-line no-console
      console.log(
        `REPAIRED ${moved.length} of ${interactive.length}:`,
        moved.map((row) => `${row.title.slice(0, 28)} → ${where(row.place)}`).join(" | "),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

const where = (place: SessionPlace): string =>
  `${place.subMode ?? "—"}${place.surface === null ? "" : ` / ${place.surface}`}`;
