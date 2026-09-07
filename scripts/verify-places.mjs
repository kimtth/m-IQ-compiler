/**
 * Run the place repair against a copy of a real `~/.iq-compiler` and report
 * what it derived. Read-only against the original: point IQ_HOME at a copy.
 *
 *   node --import tsx scripts/verify-places.mjs <IQ_HOME>
 *
 * Kept as a script rather than a test because it needs a real profile, which a
 * suite must never depend on. It exists because "the tab is wrong" was
 * reported twice against data that no unit fixture had, and the only way to
 * answer it was to fold the user's own logs.
 */
import { resolveAppPaths, ensureAppPaths } from "@iq/core";
import { SessionRepo } from "@iq/core/dist/runtime/sessions/fs-repo.js";
import { SessionsService } from "@iq/core/dist/runtime/sessions/sessions.js";

const root = process.argv[2];
if (!root) {
  console.error("usage: verify-places.mjs <IQ_HOME>");
  process.exit(2);
}

const paths = resolveAppPaths(root);
await ensureAppPaths(paths);
const repo = new SessionRepo(paths);

const before = await repo.list();

const service = new SessionsService({
  paths,
  sessionRepo: repo,
  turnRepo: { read: async () => [], delete: async () => {} },
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => logger },
  publishIndex: () => {},
  toolRegistry: { familyOf: () => null },
});

await service.placeExistingConversations();

const after = await repo.list();
const where = (place) =>
  `${place.subMode ?? "—"}${place.surface ? ` / ${place.surface}` : ""}`;

console.log("title".padEnd(34), "before".padEnd(22), "after");
for (const summary of after) {
  if (summary.origin !== "interactive") continue;
  const was = before.find((row) => row.id === summary.id);
  console.log(
    summary.title.slice(0, 32).padEnd(34),
    where(was?.place ?? { subMode: null, surface: null }).padEnd(22),
    where(summary.place),
  );
}
