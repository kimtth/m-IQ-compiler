import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import type { GraphNode, KnowledgeGraph } from "@iq/shared";

/**
 * The knowledge graph's layout.
 *
 * A `graphology` graph carrying positions, ready for sigma to draw. The
 * arrangement is decided here and never animates: the same vault always
 * produces the same picture, so the shape a user learns to recognise does not
 * rearrange itself between visits.
 */

/**
 * The ceiling on drawn nodes.
 *
 * It used to be 500, set by what an SVG of React elements could repaint
 * without dropping frames. Sigma draws in WebGL and ForceAtlas2 approximates
 * repulsion with a quadtree, so both of the reasons for a low ceiling are
 * gone. What is left is legibility, and past a few thousand nodes a vault is
 * a texture rather than a map.
 */
export const MAX_DRAWN = 5000;

/**
 * Enough passes to untangle a vault, and no more.
 *
 * ForceAtlas2 converges faster than the Fruchterman-Reingold this replaced,
 * because `outboundAttractionDistribution` spreads a hub's pull across its
 * links instead of letting forty of them drag forty neighbours into one blob.
 */
const ITERATIONS = 260;

/** Below this the quadtree costs more to build than the pairs it skips. */
const BARNES_HUT_FROM = 200;

export interface NodeAttributes {
  x: number;
  y: number;
  size: number;
  label: string;
  /** Kept on the node so the reducers and the search can read them back. */
  title: string;
  path: string;
  degree: number;
}

export type KnowledgeLayout = Graph<NodeAttributes, EdgeAttributes>;

/** Edges carry no attributes of their own; the reducer decides how they look. */
export type EdgeAttributes = Record<string, never>;

export interface DrawnGraph {
  graph: KnowledgeLayout;
  /** Nodes ranked out by the ceiling, so the surface can say how many. */
  hidden: number;
}

/**
 * Place a knowledge graph.
 *
 * Nothing here decides a colour. Sigma's reducers paint every node and edge on
 * every frame, and they can follow a theme change without any of this running
 * again — which matters, because this is the expensive half.
 */
export function buildLayout(knowledge: KnowledgeGraph): DrawnGraph {
  const drawn = [...knowledge.nodes].sort((a, b) => b.degree - a.degree).slice(0, MAX_DRAWN);

  const graph: KnowledgeLayout = new Graph({
    type: "undirected",
    multi: false,
    allowSelfLoops: false,
  });
  // A fixed seed, so the ring the simulation starts from is the same one every
  // time. ForceAtlas2 itself has no randomness, so this is the only thing
  // standing between the layout and a picture that moves on every visit.
  let seed = 0x2f6e2b1;
  const random = (): number => {
    seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  drawn.forEach((node, i) => {
    // Start on a ring: a random cloud needs many more passes to untangle.
    const angle = (i / Math.max(drawn.length, 1)) * Math.PI * 2;
    graph.addNode(node.id, {
      x: Math.cos(angle) * (120 + random() * 140),
      y: Math.sin(angle) * (100 + random() * 120),
      size: sizeOf(node),
      label: node.title.slice(0, 60),
      title: node.title,
      path: node.path,
      degree: node.degree,
    });
  });

  for (const edge of knowledge.edges) {
    if (edge.from === edge.to) continue;
    if (!graph.hasNode(edge.from) || !graph.hasNode(edge.to)) continue;
    if (graph.hasEdge(edge.from, edge.to)) continue;
    graph.addEdge(edge.from, edge.to, {});
  }

  forceAtlas2.assign(graph, {
    iterations: ITERATIONS,
    settings: {
      // The quadtree is what turns an O(n²) pass into O(n log n). It is the
      // whole reason a vault of thousands can be laid out at all.
      barnesHutOptimize: graph.order >= BARNES_HUT_FROM,
      barnesHutTheta: 0.5,
      // A hub's attraction is divided among its links rather than applied once
      // per link. Without it a well-connected note pulls its whole
      // neighbourhood onto itself and takes that part of the picture out.
      outboundAttractionDistribution: true,
      // Gravity is what holds the disconnected parts of a vault — the skills,
      // the notes nobody has linked — near the main mass. Nothing attracts
      // them to it, so without gravity repulsion pushes them off the frame
      // and the part anyone wanted to look at shrinks to a speck.
      gravity: 1,
      scalingRatio: 10,
      // Larger graphs take smaller steps, or the first passes throw nodes far
      // enough that the rest of the run is spent bringing them back.
      slowDown: 1 + Math.log(graph.order + 1),
      edgeWeightInfluence: 0,
      adjustSizes: false,
      linLogMode: false,
      strongGravityMode: true,
    },
  });

  return { graph, hidden: knowledge.nodes.length - drawn.length };
}

/**
 * Area by link count, so a hub reads as a hub before any label is legible.
 *
 * Small on purpose. Large discs are most of the ink at vault scale: a few
 * hundred notes draw as overlapping blobs with the links hidden underneath,
 * which loses the one thing the picture is for. A node marks a position; the
 * shape is carried by where the nodes sit and what joins them.
 */
function sizeOf(node: GraphNode): number {
  return 2 + Math.min(Math.sqrt(node.degree) * 1.6, 9);
}
