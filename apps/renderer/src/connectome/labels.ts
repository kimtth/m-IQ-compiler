/**
 * Names for the nodes on the map.
 *
 * The map used to be nameless. A reader could see that two cells were coupled
 * and could not see *which two*, so an answer in the chat that named an IQ Cell
 * and lit it on the picture still left them counting dots. The list beside the
 * map answers "where is the one called X"; the map has to answer "what is that
 * one", and only a label on the node does that.
 *
 * The label is not the name. A full IQ Cell name is a sentence — "Apply: how we
 * name engineering changes" — and forty of those written across a 400px pane is
 * a wall of text with a picture behind it. What is wanted is the shortest thing
 * that still identifies the node, so the opening words that every name shares
 * ("Ask the …", "Apply: …", "Brief me on …") are dropped and what is left is
 * cut to a few words. The full name is still one hover away, on the element's
 * `title`.
 *
 * Shortening can collide, and a map with two nodes both labelled
 * "Standards notes" is worse than no labels at all. So the shortening is done
 * for the whole set at once: any label two cells would share is redrawn for
 * both at a longer budget, where the names differ.
 */

/** Characters a short label is cut to. Roughly two or three words. */
const LABEL_BUDGET = 20;

/**
 * The budget a colliding pair is redrawn at. Long enough to separate two names
 * that share an opening, short enough to stay one line on a narrow pane.
 */
const FULL_BUDGET = 34;

/**
 * Words that open an IQ Cell name without saying which cell it is.
 *
 * Only ever dropped from the *front*, and never past the point where two words
 * are left: a name made entirely of these ("Apply 3 conventions" is close) must
 * still produce something to read.
 */
const OPENERS = new Set([
  "a",
  "an",
  "and",
  "apply",
  "ask",
  "brief",
  "draft",
  "for",
  "from",
  "get",
  "how",
  "in",
  "me",
  "my",
  "of",
  "on",
  "our",
  "run",
  "that",
  "the",
  "this",
  "to",
  "use",
  "we",
  "what",
  "with",
  "write",
]);

/**
 * Words a cut label must not end on.
 *
 * "Pull together the…" spends three of its twenty characters saying nothing
 * and stops in the middle of a phrase, which reads as a broken string rather
 * than a short name. "Pull together…" says the same thing and stops where a
 * person would.
 */
const TRAILING = new Set([
  ...OPENERS,
  "against",
  "as",
  "at",
  "by",
  "into",
  "over",
  "per",
  "than",
  "when",
  "where",
  "which",
]);

const bare = (word: string): string => word.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Cut at a word boundary inside the budget, falling back to a hard cut. */
const truncate = (text: string, budget: number): string => {
  if (text.length <= budget) return text;
  let kept: string[] = [];
  let length = 0;
  for (const word of text.split(" ")) {
    const next = length === 0 ? word.length : length + word.length + 1;
    if (next > budget) break;
    kept.push(word);
    length = next;
  }
  while (kept.length > 1 && TRAILING.has(bare(kept[kept.length - 1] ?? ""))) kept = kept.slice(0, -1);
  if (kept.length === 0) return `${text.slice(0, Math.max(1, budget - 1))}…`;
  return `${kept.join(" ")}…`;
};

/** The shortest reading of one name that still identifies it. */
export const shortLabel = (name: string, budget: number = LABEL_BUDGET): string => {
  const colon = name.indexOf(":");
  const tail = colon >= 0 ? name.slice(colon + 1) : name;
  const words = tail.trim().split(/\s+/).filter((word) => word.length > 0);

  let start = 0;
  while (words.length - start > 2 && OPENERS.has(bare(words[start] ?? ""))) start += 1;

  const kept = words.slice(start).join(" ").trim() || name.trim();
  const short = truncate(kept, budget);
  return short.charAt(0).toUpperCase() + short.slice(1);
};

/**
 * Short labels for a whole graph, with collisions resolved.
 *
 * Two cells that shorten to the same words are both redrawn at the longer
 * budget rather than one of them being left ambiguous — the reader has no way
 * to tell which of the two got the short form.
 */
export const shortLabelsFor = (
  nodes: readonly { id: string; name: string }[],
): Map<string, string> => {
  const labels = new Map(nodes.map((node) => [node.id, shortLabel(node.name)]));

  const byLabel = new Map<string, string[]>();
  for (const [id, label] of labels) {
    const key = label.toLowerCase();
    byLabel.set(key, [...(byLabel.get(key) ?? []), id]);
  }

  const names = new Map(nodes.map((node) => [node.id, node.name]));
  for (const ids of byLabel.values()) {
    if (ids.length < 2) continue;
    for (const id of ids) labels.set(id, shortLabel(names.get(id) ?? "", FULL_BUDGET));
  }

  return labels;
};
