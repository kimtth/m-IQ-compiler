import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Sparkles } from "lucide-react";
import type {
  FabricSkillPack,
  SkillEvolutionRun,
  SkillEvolutionStatus,
  SkillImportPreview,
  SkillRecord,
} from "@iq/shared";
import { call, callAs, subscribe } from "../bridge.js";
import { SAMPLE_EVOLUTION_RUN, useSampleData } from "../samples/index.js";

/**
 * Skills.
 *
 * The standing set of procedures the agent may load, and the evolution runs
 * that propose changes to them. Read and changed for the same reason someone
 * opens the audit log — to see what this thing is allowed to do.
 */

/**
 * Panel props.
 *
 * Re-declared per module rather than imported from a common file: `{ onError }`
 * is not a shared concept, it is the same two words. The old `panels.tsx` held
 * nine components and two disjoint importers with `PanelProps` as the only
 * thing they had in common, which is not enough to be a module.
 */
export interface PanelProps {
  onError: (problem: unknown) => void;
  /** The scope anything compiled from a panel is published into. */
  projectId?: string | null;
}
// --- skills -----------------------------------------------------------------

interface Proposal {
  name: string;
  description: string;
  rationale: string;
  proposedAt: string;
}

/**
 * Why a skill cannot be improved right now, or "" when it can.
 *
 * Asked by the surface rather than discovered by pressing the button: the
 * precondition lives on the privileged side, and offering a control that can
 * only report its own refusal is the defect this repo has now hit four times.
 */
function evolutionBlocker(
  status: SkillEvolutionStatus | null,
  skill: SkillRecord,
): string {
  if (status === null) return "Checking whether skill evolution is available\u2026";
  if (!status.ready) return status.message;
  if (status.run !== null && RUNNING_STATES.has(status.run.status)) {
    return `Already improving ${status.run.skillName}. One run at a time \u2014 they are expensive.`;
  }
  if (skill.origin === "bundled" && skill.review !== "approved") {
    return "Approve this skill before improving it.";
  }
  return "";
}

const RUNNING_STATES = new Set(["preparing", "baseline", "evolving", "validating"]);

const EVOLUTION_STAGE: Record<string, string> = {
  preparing: "Inventing tasks to measure the skill against",
  baseline: "Scoring the skill as it stands",
  evolving: "Rewriting the procedure and re-scoring it",
  validating: "Checking the rewrite against its gates",
};

export function Skills({ onError }: PanelProps): JSX.Element {
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [pack, setPack] = useState<FabricSkillPack | null>(null);
  const [preview, setPreview] = useState<SkillImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [evolution, setEvolution] = useState<SkillEvolutionStatus | null>(null);

  const load = useCallback(async () => {
    try {
      setSkills(await call("skills:list"));
      setProposals(await callAs<Proposal[]>("skills:listProposals"));
      setPack(await call("fabric:skillPack"));
      setEvolution(await call("skills:evolutionStatus"));
    } catch (problem) {
      onError(problem);
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * A run takes minutes, so its progress arrives as events rather than as the
   * result of the call that started it. When one settles the whole surface is
   * reloaded, because a successful run has written a proposal into the card
   * above.
   */
  useEffect(
    () =>
      subscribe<SkillEvolutionRun>("skills:evolutionChanged", (run) => {
        setEvolution((current) => (current === null ? current : { ...current, run }));
        if (run.status === "succeeded" || run.status === "failed") void load();
      }),
    [load],
  );

  const act = async (
    channel: "skills:approve" | "skills:approveInstalled" | "skills:archive" | "skills:remove",
    name: string,
  ): Promise<void> => {
    try {
      await call(channel, { name });
      await load();
    } catch (problem) {
      onError(problem);
    }
  };

  /**
   * Import is deliberately two steps. Choosing a folder only inspects it; what
   * comes back is shown in full, above all the tool families the skill asks
   * for, because installing one is closer to editing the system prompt than to
   * copying a file.
   */
  const chooseImport = async (): Promise<void> => {
    setBusy(true);
    try {
      const { source } = await call("skills:chooseImport");
      if (source === "") return;
      setPreview(await call("skills:inspectImport", { source }));
    } catch (problem) {
      onError(problem);
    } finally {
      setBusy(false);
    }
  };

  const confirmImport = async (): Promise<void> => {
    if (!preview) return;
    setBusy(true);
    try {
      await call("skills:import", { source: preview.source });
      setPreview(null);
      await load();
    } catch (problem) {
      onError(problem);
    } finally {
      setBusy(false);
    }
  };

  const exportSkill = async (name: string): Promise<void> => {
    try {
      const result = await call("skills:export", { name });
      if (result.destination !== "") await load();
    } catch (problem) {
      onError(problem);
    }
  };

  return (
    <>
      <div className="pane-header">
        <strong>Skills</strong>
        <span className="muted">Procedures the assistant can load on demand</span>
        <div className="spacer" />
        <button onClick={() => void chooseImport()} disabled={busy}>
          Import…
        </button>
      </div>
      <div className="pane-body">
        {preview && (
          <div className="card approval">
            <h3>Import "{preview.name}"?</h3>
            <p className="muted">{preview.source}</p>

            {preview.problems.length > 0 ? (
              <div className="notice">
                This folder is not a valid Agent Skills bundle:
                <ul>
                  {preview.problems.map((problem) => (
                    <li key={problem}>{problem}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <>
                <p>{preview.description}</p>
                <p className="muted">
                  Tool families it asks for:{" "}
                  {preview.allowedTools.length > 0 ? preview.allowedTools.join(", ") : "none"}
                </p>
                {preview.resources.length > 0 && (
                  <p className="muted">
                    Bundled files: {preview.resources.slice(0, 8).join(", ")}
                    {preview.resources.length > 8 ? ` and ${preview.resources.length - 8} more` : ""}
                  </p>
                )}
                {preview.conflicts && (
                  <div className="notice">
                    A skill named "{preview.name}" is already installed and will be replaced.
                  </div>
                )}
                <details>
                  <summary>What it instructs the assistant to do</summary>
                  <pre className="source">{preview.bodyExcerpt}</pre>
                </details>
                <p className="muted">
                  Importing installs it disabled. It stays inert until you approve it below.
                </p>
              </>
            )}

            <div className="row" style={{ marginTop: 8 }}>
              <button
                className="primary"
                onClick={() => void confirmImport()}
                disabled={busy || preview.problems.length > 0}
              >
                Import
              </button>
              <button onClick={() => setPreview(null)}>Cancel</button>
            </div>
          </div>
        )}
        {/* Rendered whether or not there is anything in it.
            This card used to be wrapped in `proposals.length > 0`, which meant
            that on a queue with nothing in it — the ordinary case — there was
            no evidence anywhere in the app that skills can be proposed at all.
            Three things write here, and a surface that only appears once one of
            them has already fired cannot tell anyone that. */}
        <div className="card approval">
          <h3>Proposed by the assistant ({proposals.length})</h3>
          {proposals.length === 0 ? (
            <>
              <p className="muted">
                Nothing is waiting for review. Proposals arrive here from three places, and
                none of them can install a skill on their own — a skill goes into the system
                prompt, so a person approves it.
              </p>
              <ul className="muted">
                <li>
                  The assistant writing one during a turn, when it notices a procedure worth
                  keeping.
                </li>
                <li>
                  IQ Memories turning approved memories about one subject into a{" "}
                  <code>learned-</code> skill, once there are enough of them.
                </li>
                <li>
                  <strong>Improve…</strong> on a skill below, which rewrites its procedure and
                  measures whether the rewrite is actually better.
                </li>
              </ul>
            </>
          ) : (
            <>
              <p className="muted">These stay inactive until you approve them.</p>
              {proposals.map((proposal) => (
                <div key={proposal.name} style={{ marginTop: 12 }}>
                  <strong>{proposal.name}</strong>
                  <div className="muted">{proposal.description}</div>
                  <div className="muted" style={{ marginTop: 4 }}>
                    Why: {proposal.rationale}
                  </div>
                  {proposal.proposedAt !== "" && (
                    <div className="muted" style={{ marginTop: 4 }}>
                      Proposed {new Date(proposal.proposedAt).toLocaleString()}
                    </div>
                  )}
                  <div className="row" style={{ marginTop: 8 }}>
                    <button
                      className="primary"
                      onClick={() => void act("skills:approve", proposal.name)}
                    >
                      Approve
                    </button>
                    <button
                      className="danger"
                      onClick={() => void act("skills:archive", proposal.name)}
                    >
                      Reject
                    </button>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>

        <EvolutionCard status={evolution} onError={onError} onSettled={() => void load()} />

        <div className="grid">
          {skills.map((skill) => (
            <div className="card" key={skill.name}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <h3>{skill.name}</h3>
                <div className="row">
                  <span className="pill">{skill.origin}</span>
                  <span className={`pill${skill.review === "approved" ? " ok" : ""}`}>
                    {skill.review}
                  </span>
                  <button
                    onClick={() =>
                      void call("skills:setEnabled", { name: skill.name, enabled: !skill.enabled })
                        .then(load)
                        .catch(onError)
                    }
                    disabled={skill.review !== "approved"}
                    title={
                      skill.review === "approved"
                        ? ""
                        : "Approve this skill before it can be enabled"
                    }
                  >
                    {skill.enabled ? "Disable" : "Enable"}
                  </button>
                </div>
              </div>
              <div className="muted">{skill.description}</div>
              {skill.allowedTools.length > 0 && (
                <div className="muted" style={{ marginTop: 6 }}>
                  Tools: {skill.allowedTools.join(", ")}
                </div>
              )}
              <div className="row" style={{ marginTop: 8 }}>
                {skill.review === "pending_review" && (
                  <button
                    className="primary"
                    onClick={() => void act("skills:approveInstalled", skill.name)}
                  >
                    Approve
                  </button>
                )}
                <ImproveButton skill={skill} status={evolution} onError={onError} />
                <button onClick={() => void exportSkill(skill.name)}>Export…</button>
                {skill.origin !== "bundled" && (
                  <button className="danger" onClick={() => void act("skills:remove", skill.name)}>
                    Remove
                  </button>
                )}
              </div>
            </div>
          ))}
          {skills.length === 0 && <p className="muted">No skills installed yet.</p>}
        </div>

        <FabricPackSection pack={pack} />
      </div>
    </>
  );
}

/**
 * Start an evolution run for one skill.
 *
 * Disabled with the reason rather than hidden: "you cannot improve this right
 * now" is useful, and a control that silently disappears teaches nothing.
 */
function ImproveButton({
  skill,
  status,
  onError,
}: {
  skill: SkillRecord;
  status: SkillEvolutionStatus | null;
  onError: (problem: unknown) => void;
}): JSX.Element {
  const blocked = evolutionBlocker(status, skill);
  return (
    <button
      disabled={blocked !== ""}
      title={
        blocked !== ""
          ? blocked
          : // The cost is stated because it is unusual: measured at ~43s per
            // rewrite against Copilot, the default budget is roughly half an
            // hour of model calls. A button that quietly spends that is a
            // surprise on a bill.
            "Rewrite this skill's procedure and measure whether it improved. Takes around half an hour of model calls; you can stop it at any point."
      }
      onClick={() => {
        call("skills:evolve", { name: skill.name, budget: 40 }).catch(onError);
      }}
    >
      <Sparkles size={14} aria-hidden="true" /> Improve…
    </button>
  );
}

/**
 * A run in flight, or the last one.
 *
 * Shows the judge's feedback rather than only the score, because the feedback
 * is the mechanism: GEPA rewrites the procedure in response to that text, and
 * someone deciding whether to approve the result is entitled to see the
 * reasoning that produced it.
 */
function EvolutionCard({
  status,
  onError,
  onSettled,
}: {
  status: SkillEvolutionStatus | null;
  onError: (problem: unknown) => void;
  onSettled: () => void;
}): JSX.Element | null {
  const sampleData = useSampleData();
  const [showSample, setShowSample] = useState(false);

  if (status === null) return null;

  // A real run always wins. The sample exists to show what this produces before
  // anyone has bought one, so the moment there is a real one to look at, the
  // worked example would only be in the way.
  const live = status.run;
  const run = live ?? (showSample ? SAMPLE_EVOLUTION_RUN : null);
  const isSample = live === null && run !== null;

  if (run === null) {
    const offer = sampleData ? (
      <button onClick={() => setShowSample(true)}>Load sample</button>
    ) : null;

    if (status.ready) {
      // Nothing has been run and nothing is wrong. Worth a card only when there
      // is a sample to offer — otherwise the Improve… buttons say it all.
      if (offer === null) return null;
      return (
        <div className="card">
          <h3>Improving a skill</h3>
          <p className="muted">
            Improve… rewrites a skill&apos;s procedure and measures whether the rewrite is
            actually better. A run takes several minutes of model calls, so here is what one
            looks like when it finishes.
          </p>
          <div className="row">{offer}</div>
        </div>
      );
    }

    // It cannot run. Say why — the Improve… buttons carry the same reason, but
    // that is a tooltip on a disabled control, which nobody reads before
    // wondering why it is disabled.
    return (
      <div className="card">
        <h3>Improving a skill</h3>
        <p className="muted">{status.message}</p>
        {offer !== null && (
          <>
            <p className="muted">You can still see what a finished run looks like.</p>
            <div className="row">{offer}</div>
          </>
        )}
      </div>
    );
  }

  const running = RUNNING_STATES.has(run.status);
  const recent = run.candidates.slice(-1)[0] ?? null;

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h3>Improving {run.skillName}</h3>
        <div className="row">
          {isSample && <span className="chip beta">Sample</span>}
          <span className={`pill${run.status === "succeeded" ? " ok" : run.status === "failed" ? " bad" : ""}`}>
            {run.status}
          </span>
        </div>
      </div>

      {running && (
        <>
          <p className="muted">{EVOLUTION_STAGE[run.status] ?? "Working…"}</p>
          {/* Two separate facts, not a ratio. `candidates` counts every judged
              response — scoring the original, GEPA's own rollouts, and the
              final measurement — while `budget` caps only GEPA's rollouts. So
              the count legitimately passes the budget: measured at 22 judged
              against a budget of 12, and 62 against 60. Printed as "N of about
              M" it overshoots and reads as a broken counter, which is the same
              defect as a plan that reports more questions than it shows. */}
          <p className="muted">
            {run.candidates.length} responses judged · budget {run.budget} rewrites
            {run.best !== null && ` · best ${run.best.composite.toFixed(2)}`}
            {run.baseline !== null && ` · original ${run.baseline.composite.toFixed(2)}`}
          </p>
          {recent?.feedback && (
            <details>
              <summary>What the judge said most recently</summary>
              <p className="muted">{recent.feedback}</p>
            </details>
          )}
          <div className="row" style={{ marginTop: 8 }}>
            <button
              className="danger"
              onClick={() => void call("skills:cancelEvolve").then(onSettled).catch(onError)}
            >
              Stop
            </button>
          </div>
        </>
      )}

      {run.status === "succeeded" &&
        (isSample ? (
          // The sample must not claim there is something to review: the queue
          // above is real, and pointing at a proposal that is not in it would
          // be the one lie a worked example cannot afford.
          <p>
            A rewrite of <strong>{run.proposal}</strong> scored{" "}
            {run.best?.composite.toFixed(2) ?? "?"} against the original&apos;s{" "}
            {run.baseline?.composite.toFixed(2) ?? "?"}. In a real run it would now be waiting
            for review above — a proposal, with nothing changed until you approve it.
          </p>
        ) : (
          <p>
            A rewrite of <strong>{run.proposal}</strong> is waiting for review above, scoring{" "}
            {run.best?.composite.toFixed(2) ?? "?"} against the original&apos;s{" "}
            {run.baseline?.composite.toFixed(2) ?? "?"}. It is a proposal — nothing changed until
            you approve it.
          </p>
        ))}

      {isSample && run.candidates.length > 0 && (
        <details style={{ marginTop: 8 }}>
          <summary>What the judge said — three of the evaluations</summary>
          {run.candidates.map((entry) => (
            <p className="muted" key={entry.iteration}>
              <strong>{entry.score.composite.toFixed(2)}</strong> — {entry.feedback}
            </p>
          ))}
          <p className="muted">
            A real run judges dozens; these are three of them. That text is the mechanism, not
            a log: the optimizer rewrites the procedure in response to the reason, which is why
            the score alone would not be enough.
          </p>
        </details>
      )}

      {run.status === "failed" && <p className="muted">{run.problem}</p>}
      {run.status === "cancelled" && <p className="muted">Stopped. Nothing was proposed.</p>}

      {run.constraints.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <strong>Gates</strong>
          {run.constraints.map((gate) => (
            <div className="muted" key={gate.name}>
              {gate.passed ? "✓" : "✗"} {gate.name}
              {gate.message !== "" && ` — ${gate.message}`}
            </div>
          ))}
        </div>
      )}

      {run.modelId !== "" && (
        <div className="muted" style={{ marginTop: 8 }}>
          Using {run.modelId}.
        </div>
      )}

      {isSample && (
        <div className="row" style={{ marginTop: 8 }}>
          <button onClick={() => setShowSample(false)}>Clear sample</button>
        </div>
      )}
    </div>
  );
}

/**
 * The Microsoft Fabric skill pack, listed where the rest of the skills are.
 *
 * These are not this app's skills and the surface says so plainly: they are
 * `microsoft/skills-for-fabric` as resolved on this machine, they ground
 * Co-create → Fabric runs, and nothing here can be enabled, approved, edited
 * or removed from inside the app — the way to change them is to change the
 * installed bundle. Showing them anyway matters because the alternative is a
 * Skills surface that lists nine things while thirty are in play, and a user
 * who cannot see what the agent is reading cannot judge what it did.
 *
 * Skills, agents and shared references are shown together because the bundle
 * ships them together: the agents decide which skill answers a request, and
 * the `common/` documents are what the skills defer to for the parts they
 * share. Listing only the skills would show the vocabulary and hide the
 * grammar.
 */
function FabricPackSection({ pack }: { pack: FabricSkillPack | null }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (pack === null) return null;
  if (!pack.available) {
    return (
      <div className="card" style={{ marginTop: 12 }}>
        <div className="row between">
          <h3>Microsoft Fabric skill pack</h3>
          <span className="pill bad">not found</span>
        </div>
        <p className="muted">{pack.message}</p>
      </div>
    );
  }

  const total = pack.skills.length + pack.agents.length + pack.references.length;

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="row between">
        <h3>Microsoft Fabric skill pack</h3>
        <span className="pill ok">
          skills-for-fabric {pack.version || "unversioned"} · {pack.source}
        </span>
      </div>
      <p className="muted">
        {pack.skills.length} skills, {pack.agents.length} agents and {pack.references.length} shared
        references across {pack.bundles.join(", ")}. Read by Co-create → Fabric runs, not loaded
        into ordinary turns — they are the installed bundle, so they are changed there rather than
        here.
      </p>
      <div className="muted mono">{pack.root}</div>

      {pack.bundleDetails.map((bundle) => (
        <div className="row between" key={bundle.name} style={{ marginTop: 6 }}>
          <span>
            <strong>{bundle.name}</strong>{" "}
            <span className="muted">{bundle.description}</span>
          </span>
          <div className="row">
            {bundle.mcpServers.map((server) => (
              <span className="pill" key={server}>
                MCP: {server}
              </span>
            ))}
            <span className="pill">{bundle.version || "unversioned"}</span>
          </div>
        </div>
      ))}

      <div className="row" style={{ marginTop: 10 }}>
        <button onClick={() => setOpen((current) => !current)}>
          {open ? "Hide the list" : `Show all ${total}`}
        </button>
      </div>

      {open && (
        <div style={{ marginTop: 10 }}>
          {pack.agents.length > 0 && (
            <>
              <strong>Agents</strong>
              {pack.agents.map((agent) => (
                <div key={agent.path} style={{ marginTop: 6 }}>
                  <span>{agent.name}</span> <span className="pill">{agent.bundle}</span>
                  <div className="muted">{agent.description}</div>
                </div>
              ))}
            </>
          )}

          <strong style={{ display: "block", marginTop: 12 }}>Skills</strong>
          {pack.skills.map((skill) => (
            <div key={skill.directory} style={{ marginTop: 6 }}>
              <span>{skill.name}</span> <span className="pill">{skill.bundle}</span>
              <div className="muted">{skill.description}</div>
            </div>
          ))}

          {pack.references.length > 0 && (
            <>
              <strong style={{ display: "block", marginTop: 12 }}>Shared references</strong>
              <div className="muted">
                {pack.references.map((reference) => `${reference.bundle}/${reference.name}`).join(", ")}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
