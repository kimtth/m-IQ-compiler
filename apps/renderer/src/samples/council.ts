/**
 * The council roster the Load sample button fills in.
 *
 * Not a module of the samples hub, and deliberately so: nothing is written
 * anywhere. It fills the form and stops, so there is no "loaded" state to
 * report, nothing to clear from a store, and no way for it to be sitting in
 * someone's data six months later. The only thing it shares with the real
 * modules is that it is a worked example, which is why it lives here.
 *
 * A council is the surface whose empty state asks the most of a newcomer:
 * before anything happens they must invent a genuinely debatable question *and*
 * a roster of stances that will actually disagree. Presets solve half of that —
 * they carry members and no question — so the pane still opened on a blank
 * textarea above two blank rows.
 *
 * The question has no correct answer on purpose. A council asked something
 * factual produces four agreeing paragraphs and teaches the reader that the
 * feature does nothing. The stances are written to conflict: a delivery date
 * and the need for a careful review genuinely pull against each other.
 */

/** A member being edited before the run; the id is assigned by the backend. */
export interface DraftMember {
  name: string;
  stance: string;
  modelId: string;
  skills: string;
  toolFamilies: string;
}

export const BLANK_MEMBER: DraftMember = {
  name: "",
  stance: "",
  modelId: "",
  skills: "",
  toolFamilies: "",
};

export const SAMPLE_COUNCIL = {
  question:
    "The final review is rejecting 3% of completed requests even though the team believes most are correct. Do we simplify the check to meet the delivery date, or keep it and delay by two weeks?",
  roundBudget: 3,
  members: [
    {
      name: "Delivery",
      stance:
        "Argue for keeping the delivery date. Every week of delay has a cost the team has already committed to.",
      modelId: "",
      skills: "",
      toolFamilies: "",
    },
    {
      name: "Customer trust",
      stance:
        "Argue from customer risk. A real problem that passes the review could create repeat requests and damage trust.",
      modelId: "",
      skills: "",
      toolFamilies: "",
    },
    {
      name: "Quality review",
      stance:
        "Judge whether the rejected work points to a review problem or a delivery problem, and say what evidence would settle it.",
      modelId: "",
      skills: "",
      toolFamilies: "",
    },
  ],
} as const satisfies { question: string; roundBudget: number; members: readonly DraftMember[] };
