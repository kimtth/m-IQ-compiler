import {
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  Color,
  DynamicDrawUsage,
  InstancedMesh,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  PerspectiveCamera,
  Points,
  Raycaster,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { arrivalOf, type ConnectomeGraph } from "@iq/shared";
import { shortLabelsFor } from "./labels.js";

/**
 * The Connectome render.
 *
 * A tractography-style picture, and deliberately an anatomical one: the layout
 * is folded onto a bilateral cortical envelope, fibres are routed the way white
 * matter actually runs — association bundles bowing outward through their own
 * hemisphere, commissural bundles diving to the midline and arching over it —
 * and every connection is a bundle of many near-parallel curves that converge
 * on their parcels and fan through the middle. A strong coupling reads as a
 * thick tract and a weak one as a wisp. Colour is direction-coded the way a DTI
 * render is — red for left–right, green for front–back, blue for up–down — and
 * tinted by bundle, which keeps the palette organic rather than categorical.
 *
 * The shape matters as much as the data. Straight chords between points in an
 * abstract cloud render as a ball of string no matter how they are coloured;
 * the envelope, the midline gap and the arched routing are what make the same
 * numbers read as a brain.
 *
 * A node is one object, not two. It was a sphere wearing a torus, which read as
 * a ringed planet rather than a cell; then it was an unlit sphere with a halo
 * sprite behind it, which a capture of the real render showed to be a flat,
 * faceted, hard-edged disc with the halo buried invisibly inside it. It is now
 * a single additive sprite: a bright core in the bundle's hue, and a corona
 * carrying completion rate as colour. The corona flashes when the strongest
 * tract running into that node delivers, so the picture reads as a network
 * firing instead of a still.
 *
 * The surface is always dark, in both app themes. The map is the one saturated
 * data surface in a monochrome product, and additive light needs somewhere dark
 * to be added to — the same fibre field on a white ground is grey wool. The
 * chrome around the map still follows the app theme.
 *
 * The whole picture is rendered deterministically from the analysis: the same
 * selection, window and weights give the same image. No image model is
 * involved and none can be.
 *
 * Performance comes from batching: all fibres are one `LineSegments` draw call
 * with per-vertex colour and per-vertex reveal, so node and edge counts cost
 * geometry rather than draw calls. WebGL line width is not portable, so
 * thickness is expressed as fibre count — which is also what makes the render
 * look like a tract instead of a wire.
 */

/**
 * The fibre budget for one render.
 *
 * 40,000. It has been 7,200, then 12,000, then 7,000, then 24,000 — the cut to
 * 7,000 was made because at 12,000 the additive field stopped resolving into
 * tracts and became a lit fog. That diagnosis was right about the *brightness*
 * and wrong about the *count*: a published tractography image is tens of
 * thousands of thin streamlines, and what keeps it legible is that each one
 * contributes very little light, not that there are few of them. Cutting the
 * count was treating the symptom, and it left the map reading as a handful of
 * cords strung across a black pane.
 *
 * At 24,000 the upper half of the envelope read as tract and the lower half
 * still read as background, because the budget was being spent before the
 * weaker couplings — which is most of them — got enough streamlines to be a
 * ribbon rather than a thread. So the count goes up again and the light per
 * fibre comes down with it (`uOpacity` below). The ceiling is still a limit on
 * cost; brightness is controlled where brightness actually lives.
 */
const MAX_FIBRES = 40_000;
const SEGMENTS = 30;

/** The void the fibre field is drawn into. Mirrors `--fibre-void`. */
const VOID = 0x05070c;

/**
 * Proportions of the envelope the nodes are folded onto, as multiples of the
 * fit radius: x is left–right on screen, z is up–down on screen, y is depth
 * toward the reader.
 *
 * Wide, not tall. The opening camera looks down on the field, so x and z are
 * the two axes that decide the *shape of the hole* the graph has to fill, and
 * the map's pane is a landscape box. The previous 0.86 × 1.12 was taller than
 * it was wide, which is the opposite: measured at 1264×760 the graph used 53%
 * of the width and still ran off the top edge. 1.42 × 0.84 is roughly the
 * pane's own ratio, so the field lands on the pane instead of in a column
 * down the middle of it.
 *
 * y stays small. A flat field keeps nodes from hiding behind each other at
 * this tilt while still giving the fibres something to arc through.
 */
const CORTEX = new Vector3(1.42, 0.54, 0.84);

/**
 * The angles the camera opens on, and the only ones it can be sent back to.
 *
 * Axial — looking down on the cortex from above, with the frontal pole away
 * from the reader. That is how a tractography image is published and how one
 * is read: both hemispheres in frame, the midline running up the picture, and
 * the commissural bundles crossing it.
 *
 * It is also the only view that fits the pane. Seen from the side the field is
 * a flat, wide object in a landscape box — most of the pane would be
 * background whatever the camera distance. Seen from above it is 1.42 × 0.84,
 * which is close to the shape of the pane it has to fill.
 *
 * Named constants rather than literals buried in the field initialiser, or
 * "the opening view" is a value only the constructor knows.
 */
const HOME_THETA = 0.0;
const HOME_PHI = 0.34;

/**
 * How far the framing lifts the cortex up the pane, as a fraction of the fit
 * radius.
 *
 * `lookAt` puts the *centroid* of the node cloud at the centre of the pane, and
 * the centroid is not where the ink is. The camera is tilted 19° off vertical,
 * so the near half of the envelope — the frontal pole, at the bottom of the
 * frame — projects larger than the far half, and the visible mass sits below
 * the geometric centre. The picture read as bottom-heavy with a band of empty
 * pane above it.
 *
 * Correcting it means displacing the target *down the screen*, since the image
 * moves opposite to the target. Down-the-screen is derived from the opening
 * angles rather than written as an axis: at this tilt screen-up is
 * `(0, sin φ, −cos φ)`, which is mostly −z and not any axis a literal could
 * name.
 *
 * Small, because the framing no longer needs much. `measureFit` measures the
 * cloud's real half-extents on both screen axes about its own centroid, so the
 * ink starts out centred; the lift only answers the perspective bias that
 * makes the near half project larger. Every pixel of lift is also a pixel of
 * headroom spent, and at a tight fit there is not much to spend.
 */
const FRAME_LIFT = 0.02;

/** The unit vector pointing down the pane at the opening angles. */
const screenDown = (): Vector3 =>
  new Vector3(0, -Math.sin(HOME_PHI), Math.cos(HOME_PHI));

export interface SceneCallbacks {
  onPickNode: (id: string | null) => void;
  onPickEdge: (id: string | null) => void;
  /**
   * The time lapse advanced. Fires per frame while playing, so the reader can
   * be told which day is on screen; the caller is expected to throttle what it
   * does with it rather than re-render sixty times a second.
   */
  onEpoch?: (epoch: number) => void;
}

/**
 * How far the time lapse advances per frame.
 *
 * A whole window in about nine seconds at 60fps. Long enough that a reader can
 * see one part of the map fill before another does, short enough that watching
 * it twice is not a chore.
 */
const LAPSE_STEP = 1 / (9 * 60);

const mulberry32 = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const VERTEX = /* glsl */ `
  attribute float aT;
  attribute float aSeed;
  attribute float aSpeed;
  attribute float aReveal;
  attribute float aEdge;
  attribute float aSrc;
  attribute float aTgt;

  uniform float uTime;
  uniform float uReveal;
  uniform float uPulse;
  uniform float uSelEdge;
  uniform float uSelNode;

  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    vColor = color;

    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;

    // The time lapse. aReveal is *when* this tract was last carrying work, on
    // a 0..1 clock running from the far end of the window to now, and uReveal
    // is the moment being played. A tract therefore arrives at the point in
    // the playback where it was actually active.
    //
    // Smoothed rather than stepped, and asymmetrically: a short ramp in, then
    // a brief flare as it lands. A hard step made every tract pop into
    // existence at full brightness, which reads as a slideshow of states
    // rather than as change happening.
    float grown = smoothstep(aReveal - 0.07, aReveal + 0.01, uReveal);
    float arriving = exp(-max(0.0, uReveal - aReveal) * 26.0) * grown;

    // Taper. A tract is brightest where it converges on its parcel and thins
    // through the white matter, which is what stops the field reading as a
    // mat of uniform wires.
    float taper = mix(0.52, 1.0, pow(1.0 - sin(aT * 3.14159265), 1.3));

    // A spike travelling source → target. Every fibre in one tract shares the
    // phase, so the bundle fires as a packet rather than smearing into noise;
    // a strong coupling carries traffic more often.
    //
    // Two parts, because one was not legible. The tail is the comet trailing
    // the head — long enough to be seen as motion rather than as a flicker —
    // and the nose is a short, very bright leading edge that survives the
    // taper and the depth cue. Measured on a real frame, the old single
    // 3.8%-of-path tail moved a mean of 0.4/255 luminance between frames a
    // quarter of a second apart, which is to say the field looked static.
    float head = fract(uTime * aSpeed + aSeed);
    float behind = aT - head;
    behind -= floor(behind + 0.5);
    float tail = exp(-max(0.0, -behind) * 11.0) * step(behind, 0.002);
    float nose = exp(-abs(behind) * 80.0);
    float spike = max(tail, nose);

    // The idle field is deliberately faint: it is context, and 7200 fibres at
    // a readable brightness is the grey wool this render exists to avoid. The
    // packet is what carries the eye, so it is given the whole budget.
    float idle = 0.30 * taper;
    float packet = 5.2 * spike;
    float lit = mix(taper, idle + packet, uPulse);

    // Depth cue: the interior recedes so surface fibres stay legible.
    float depth = smoothstep(-14.0, -3.0, mv.z);

    // Selection dims everything the selection does not touch.
    float focused = 1.0;
    if (uSelEdge >= 0.0 || uSelNode >= 0.0) {
      bool hit = abs(aEdge - uSelEdge) < 0.5
        || abs(aSrc - uSelNode) < 0.5
        || abs(aTgt - uSelNode) < 0.5;
      focused = hit ? 1.25 : 0.10;
    }

    vAlpha = grown * (lit + arriving * 2.4) * mix(0.45, 1.0, depth) * focused;
  }
`;

const FRAGMENT = /* glsl */ `
  uniform float uOpacity;
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    if (vAlpha < 0.01) discard;
    gl_FragColor = vec4(vColor, clamp(vAlpha, 0.0, 1.0) * uOpacity);
  }
`;

/**
 * The soma.
 *
 * One camera-facing sprite carrying both the cell body and the light around
 * it, so a node is a source of light rather than an object. It used to be a
 * lit-looking mesh with a separate halo sprite behind it, and a capture of the
 * real render settled that argument: `MeshBasicMaterial` is unlit, so the
 * spheres came out as flat, hard-edged, visibly faceted discs that intersected
 * each other with a seam — and the halo was projected with a hardcoded `300.0`
 * instead of the viewport's own factor, which made it roughly a fifth of its
 * intended size and left it entirely buried inside the sphere it was supposed
 * to surround. Neither the corona nor the flash ever reached the screen.
 *
 * `vColor` is the bundle hue and lands in the core. `aGlow` is a brighter
 * version of that same prismatic hue for the corona. Completion remains in the
 * node detail and changes the corona intensity, but it does not turn a
 * cyan/indigo/violet map back into a green-and-red status chart. `aRate` and
 * `aPhase` are copied from the strongest tract running *into* the node, so the
 * flash is the arrival of that tract's packet rather than decoration on a
 * timer.
 */
const SOMA_VERTEX = /* glsl */ `
  attribute float aSize;
  attribute float aRate;
  attribute float aPhase;
  attribute float aReveal;
  attribute vec3 aGlow;

  uniform float uTime;
  uniform float uPulse;
  uniform float uReveal;
  /**
   * Pixels per world unit at one unit of depth: drawingBufferHeight divided by
   * 2·tan(fov/2). This has to come from the renderer, because a constant tuned
   * for one window is wrong in every other one — which is exactly how the halo
   * came to be invisible.
   */
  uniform float uProject;

  varying vec3 vColor;
  varying vec3 vGlow;
  varying float vFlash;
  varying float vGrown;

  void main() {
    vColor = color;
    vGlow = aGlow;

    float beat = fract(uTime * aRate + aPhase);
    vFlash = uPulse * step(0.0001, aRate) * exp(-beat * 5.0);

    // The same clock the tracts are on, so a cell and the tracts into it
    // arrive together instead of the picture growing in two unrelated passes.
    vGrown = smoothstep(aReveal - 0.07, aReveal + 0.01, uReveal);
    // A cell flares as it lands and settles. This is the "gradual change" the
    // playback exists to show: without it a node is either there or not, and a
    // time lapse of that is a list.
    float arriving = exp(-max(0.0, uReveal - aReveal) * 22.0) * vGrown;
    vFlash = max(vFlash, arriving);

    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float px = aSize * (0.35 + 0.65 * vGrown) * (1.0 + vFlash * 0.34) * uProject / max(0.1, -mv.z);
    // Drivers cap point size, and a sprite that hits the cap is silently
    // cropped to a square. Clamping keeps a close-up soma a circle.
    gl_PointSize = min(px, 900.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const SOMA_FRAGMENT = /* glsl */ `
  uniform float uOpacity;
  /** Where the core ends and the corona takes over, as a fraction of the sprite. */
  uniform float uCore;

  varying vec3 vColor;
  varying vec3 vGlow;
  varying float vFlash;
  varying float vGrown;

  void main() {
    if (vGrown < 0.01) discard;
    float d = length(gl_PointCoord - vec2(0.5)) * 2.0;
    if (d > 1.0) discard;

    // A soft shoulder, not a disc: a hard edge is what made the old node read
    // as a ball. The falloff is steep so the corona stays a glow around one
    // cell rather than a wash that swallows its neighbours and the tracts
    // running between them.
    float corona = pow(1.0 - d, 3.6) * (0.5 + 1.9 * vFlash);
    float core = smoothstep(uCore, uCore * 0.35, d) * 1.25;
    float total = corona + core;
    if (total < 0.004) discard;

    // Hue is the weighted average of the two zones; intensity rides in the
    // colour so the core can read as light rather than as paint. The ceiling
    // is low enough that the bundle hue survives instead of clipping to white.
    // Alpha stays flat because the blend is additive.
    vec3 rgb = (vGlow * corona + vColor * core) / total;
    gl_FragColor = vec4(rgb * min(total, 1.7), uOpacity * vGrown);
  }
`;

interface EdgeIndex {
  id: string;
  source: string;
  target: string;
  midpoint: Vector3;
}

/** One node's name, drawn as HTML over the canvas rather than into it. */
interface NodeLabel {
  id: string;
  at: Vector3;
  element: HTMLElement;
  /** Ranks the resting set: the busiest cells are the ones worth naming. */
  runs: number;
  /** World diameter of the soma sprite, so the name can be put clear of it. */
  sprite: number;
  /** Where this cell lands on the time lapse. A cell not yet arrived is not named. */
  reveal: number;
  width: number;
  height: number;
  shown: boolean;
}

/**
 * How many names the map carries when nothing is selected.
 *
 * All forty is a wall of text with a picture behind it, and none at all is the
 * problem this exists to fix. The busiest cells are named, the rest are one
 * click away — selecting a node names it and everything it is coupled to,
 * whatever their run counts.
 */
const RESTING_LABELS = 16;

/** Pixels between the edge of a soma and the top of its label. */
const LABEL_GAP = 9;

/**
 * Where the soma's bright core ends, as a fraction of the sprite it is drawn
 * in. The same 0.32 the fragment shader uses for `uCore`, plus a little, so a
 * label clears the disc rather than the faint corona around it — clearing the
 * corona too would push every name a long way off its node.
 */
const SOMA_CORE = 0.42;

/** Clear space kept around a placed label, so two never sit flush. */
const LABEL_PAD = 4;

/** A label's box in pane pixels. */
interface LabelBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const overlaps = (a: LabelBox, b: LabelBox): boolean =>
  a.left < b.right + LABEL_PAD &&
  a.right + LABEL_PAD > b.left &&
  a.top < b.bottom + LABEL_PAD &&
  a.bottom + LABEL_PAD > b.top;

/**
 * `ShaderMaterial.uniforms` is an index signature, so every lookup is
 * `possibly undefined`. Narrowing once here keeps the call sites readable.
 */
function setUniform(material: ShaderMaterial, name: string, value: number): void {
  const uniform = material.uniforms[name];
  if (uniform) uniform.value = value;
}

/**
 * Fold a layout position onto a cortex.
 *
 * The analysis lays IQ Cells out in an abstract cloud, and drawing straight
 * bundles between points in a cloud produces exactly what it sounds like: a
 * ball of string. The shape is what makes the picture read as a brain, so it
 * is imposed here rather than in the analysis — the table wants
 * the unshaped layout, and the analysis stays a statement about coupling
 * rather than about pixels.
 *
 * `raw` arrives centred on the cloud and divided by its extent, so its own
 * length says where the analysis put the node between the middle of the field
 * (0) and its rim (1). **That distance is kept.** Normalising it away and
 * substituting a random shell was what emptied the map: every node landed on
 * one thin surface, so the tracts arched over a void and the centre of the
 * pane — the part a reader looks at first — held nothing.
 *
 * Two things still shape the result. The envelope is stretched by
 * {@link CORTEX} so it is wider than it is tall, and it is flattened
 * underneath and tapered at the frontal pole, which is the difference between
 * a brain and an egg.
 */
function toCortex(raw: Vector3, depth: number, radius: number): Vector3 {
  const direction = raw.lengthSq() < 1e-6 ? new Vector3(0.4, 0.2, 0.9) : raw.clone().normalize();

  // How far out the analysis placed this node. The random `depth` only
  // thickens the sheet a little around that distance, so the field has body
  // without collapsing back onto a hollow ball.
  const fill = Math.min(1, raw.length());
  const shell = Math.min(1, 0.08 + fill * 0.86 + (depth - 0.5) * 0.12);
  const point = new Vector3(
    direction.x * CORTEX.x,
    direction.y * CORTEX.y,
    direction.z * CORTEX.z,
  ).multiplyScalar(shell * radius);

  // Midline fissure: a hint of one, not a corridor. The old 0.13·radius offset
  // pushed every single node clear of x = 0, and that gap by itself was most
  // of the empty band down the centre of the pane.
  const side = point.x >= 0 ? 1 : -1;
  point.x = side * (Math.abs(point.x) * 0.96 + 0.03 * radius);

  // Flat underneath, tapered at the front.
  if (point.y < 0) point.y *= 0.7;
  const frontal = Math.max(0, point.z / (CORTEX.z * radius));
  point.x *= 1 - 0.2 * frontal * frontal;
  point.y *= 1 - 0.12 * frontal * frontal;

  return point;
}

/** A pair of unit vectors perpendicular to `axis`, for spreading a bundle. */
function basis(axis: Vector3): [Vector3, Vector3] {
  const reference = Math.abs(axis.y) > 0.92 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
  const u = new Vector3().crossVectors(axis, reference).normalize();
  const v = new Vector3().crossVectors(axis, u).normalize();
  return [u, v];
}

export class ConnectomeScene {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera: PerspectiveCamera;
  private readonly raycaster = new Raycaster();
  private readonly callbacks: SceneCallbacks;

  private fibres: LineSegments | null = null;
  private material: ShaderMaterial | null = null;
  private nodesMesh: InstancedMesh | null = null;
  /** The light each node is made of. Replaces the sphere it used to be. */
  private somaPoints: Points | null = null;
  private somaMaterial: ShaderMaterial | null = null;
  /** The faint cortical envelope the fibres sit inside. */
  private shellMesh: Mesh | null = null;

  private nodeIds: string[] = [];
  private edgeIndex: EdgeIndex[] = [];

  /**
   * Where the names live.
   *
   * HTML over the canvas, not text drawn into it. Canvas text has no font
   * stack, no ellipsis, no theme and no way to be read by anything but eyes;
   * a span inherits all four. The layer takes no pointer events, so picking a
   * node still goes to the canvas underneath.
   */
  private labelLayer: HTMLElement | null = null;
  /** Sorted busiest-first, which is the order the resting set is filled in. */
  private labels: NodeLabel[] = [];
  private labelsById = new Map<string, NodeLabel>();
  /** Which cells each cell is coupled to, so selecting one can name its tracts. */
  private adjacency = new Map<string, Set<string>>();
  private selectedNodeId: string | null = null;
  private selectedEdgeId: string | null = null;
  /** The canvas box, cached by `resize`. Reading it per frame forces layout. */
  private viewport = { width: 1, height: 1 };
  private readonly projected = new Vector3();

  private target = new Vector3(0, 0, 0);
  private spherical = { radius: 7.4, theta: HOME_THETA, phi: HOME_PHI };  /** Where the camera is easing to, when a tour or a focus call is driving it. */
  private desired: { target: Vector3; radius: number } | null = null;
  /** Radius that frames the whole graph — recomputed per analysis, not fixed. */
  private fitRadius = 7.4;
  private nodePositions = new Map<string, Vector3>();
  /**
   * Off until asked. Motion on this surface is opt-in: a map that starts
   * drifting, growing and firing the moment it appears gives the reader
   * nothing to hold still and look at.
   */
  private autoRotate = false;
  /**
   * The moment of the time lapse being drawn: 0 at the far end of the window,
   * 1 now. 1 is the whole picture, which is what an untouched map shows.
   */
  private epoch = 1;
  private playingLapse = false;
  private pulse = 0;
  private clock = 0;
  private frame = 0;
  private disposed = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    callbacks: SceneCallbacks,
    labelLayer: HTMLElement | null = null,
  ) {
    this.callbacks = callbacks;
    this.labelLayer = labelLayer;
    this.renderer = new WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // The map owns its background. Additive light needs somewhere dark to be
    // added to, so the surface is dark in both app themes.
    this.renderer.setClearColor(VOID, 1);
    this.camera = new PerspectiveCamera(46, 1, 0.1, 100);
    this.resize();
    this.bind();
    this.loop();
  }

  /**
   * Turn the animation on or off.
   *
   * This is both the platform's reduced-motion preference and the map's own
   * Play control, because they want the same thing: with motion off the render
   * is a complete, still picture carrying exactly the same information, and
   * nothing on it moves until someone asks it to.
   */
  setMotion(enabled: boolean): void {
    this.pulse = enabled ? 1 : 0;
    // Turning motion on has to be able to turn the drift on. This read
    // `enabled && this.autoRotate`, and `autoRotate` starts false and is only
    // ever set false again (a drag or a wheel takes hold of the camera) — so
    // the expression could never become true and the slow orbit was dead code
    // the moment it was written. Taking hold of the camera still stops it; the
    // Play control is what starts it.
    this.autoRotate = enabled;
    if (!enabled) this.stopTimeLapse();
  }

  /**
   * Play the body of work forward.
   *
   * The map used to answer "what is here" and nothing else: a still field of
   * tracts, with a guided tour that flew the camera between them. That shows
   * where things are and never shows anything *happening* — a reader could not
   * tell a workload that has been steady for a month from one that appeared
   * last Tuesday, because both draw identically.
   *
   * So the reveal is a clock now rather than a decorative growth order. Each
   * tract and each cell carries the point in the window at which it was last
   * carrying work, and playing the lapse moves through that window: the
   * picture assembles itself in the order the work actually happened, cells
   * flaring as they land, and ends on the complete map.
   *
   * Restarts from the beginning when it has already finished, because the
   * alternative — pressing play on a finished lapse and watching nothing — is
   * the control appearing to be broken.
   */
  playTimeLapse(): void {
    if (this.epoch >= 0.999) this.epoch = 0;
    this.playingLapse = true;
  }

  /** Begin a newly analysed body of work at the far end of its time window. */
  restartTimeLapse(): void {
    this.epoch = 0;
    this.playingLapse = true;
  }

  pauseTimeLapse(): void {
    this.playingLapse = false;
  }

  /** Scrub to a moment. Playing stops: the reader is driving now. */
  setEpoch(epoch: number): void {
    this.epoch = Math.min(1, Math.max(0, epoch));
    this.playingLapse = false;
  }

  /** Back to the complete picture, which is the map's resting state. */
  stopTimeLapse(): void {
    this.playingLapse = false;
    this.epoch = 1;
  }

  setGraph(graph: ConnectomeGraph): void {
    this.clear();
    if (graph.nodes.length === 0) return;

    this.nodeIds = graph.nodes.map((node) => node.id);

    // The cortical envelope is sized from the layout's own extent, so two
    // IQ Cells and twenty-six both fill the pane instead of one of them being
    // a speck in it.
    const layout = graph.nodes.map((node) => new Vector3(...node.position));
    const cloudCentre = new Vector3();
    for (const point of layout) cloudCentre.add(point);
    cloudCentre.divideScalar(layout.length || 1);
    let spread = 0;
    for (const point of layout) spread = Math.max(spread, point.distanceTo(cloudCentre));
    // 1.8, not 2.4: a wider envelope buys nothing but background. The layout's
    // own extent is what the picture is about, and the multiplier only has to
    // be large enough that the midline gap and the frontal taper have room.
    const radius = Math.max(2.4, spread * 1.8);

    const shape = mulberry32(graph.seed ^ 0x9e3779b9);
    // Divided by the extent so `toCortex` receives a 0–1 distance it can keep,
    // rather than a raw length it would have to throw away.
    const reach = spread || 1;
    const positions = new Map(
      graph.nodes.map((node, index) => [
        node.id,
        toCortex(
          (layout[index] as Vector3).clone().sub(cloudCentre).divideScalar(reach),
          shape(),
          radius,
        ),
      ]),
    );
    const bundleHue = new Map(graph.bundles.map((bundle) => [bundle.id, bundle.hue]));

    this.nodePositions = positions;
    const centre = new Vector3();
    for (const point of positions.values()) centre.add(point);
    centre.divideScalar(positions.size);

    this.fitRadius = this.measureFit(centre);
    this.target.copy(centre).addScaledVector(screenDown(), this.fitRadius * FRAME_LIFT);
    this.spherical.radius = this.fitRadius;
    this.desired = null;

    const random = mulberry32(graph.seed);

    // Fibre budget: strength buys thickness, and the whole picture degrades in
    // fibre count rather than in frame rate. The floor is what makes a tract
    // read as a tract rather than as a wire — at 8 a weak coupling was a
    // single thread and the pane was mostly void — and the ramp is what keeps
    // a strong coupling visibly different from a faint one. The floor is what
    // fills the pane: most couplings in a real library are weak, so raising it
    // does far more for density than raising the ramp. Raised together with
    // `MAX_FIBRES`, against a lower `uOpacity`.
    const raw = graph.edges.map((edge) => Math.round(52 + edge.strength * 148));
    const total = raw.reduce((sum, count) => sum + count, 0);
    const scale = total > MAX_FIBRES ? MAX_FIBRES / total : 1;

    const vertices: number[] = [];
    const colors: number[] = [];
    const ts: number[] = [];
    const spikeSeeds: number[] = [];
    const speeds: number[] = [];
    const reveals: number[] = [];
    const edgeAttr: number[] = [];
    const srcAttr: number[] = [];
    const tgtAttr: number[] = [];

    const tint = new Color();
    const direction = new Color();

    /**
     * The strongest tract running into each node, so its halo flashes when
     * that tract's packet lands rather than on an unrelated timer.
     */
    const arrival = new Map<string, { rate: number; phase: number; strength: number }>();

    this.edgeIndex = [];

    graph.edges.forEach((edge, edgeIdx) => {
      const a = positions.get(edge.source);
      const b = positions.get(edge.target);
      if (a === undefined || b === undefined) return;

      const srcIdx = this.nodeIds.indexOf(edge.source);
      const tgtIdx = this.nodeIds.indexOf(edge.target);
      const hue = bundleHue.get(edge.bundleId ?? "") ?? 210;
      // Kept off the top of the lightness ramp: additive fibres accumulate, and
      // a hub with forty tracts through it clips to white if each one starts
      // bright.
      tint.setHSL(hue / 360, 0.88, 0.62);

      // One phase and one rate for the whole tract. A strong coupling carries
      // traffic more often; every fibre in the bundle fires together, so the
      // packet stays a packet.
      const spikeSeed = random();
      // Fast enough to read as traffic. At the old 0.09–0.39 a packet took
      // between two and a half and eleven seconds to cross one tract, which on
      // a captured frame pair a quarter of a second apart moved a mean of
      // 0.4/255 — a still picture, measured.
      const spikeSpeed = 0.2 + edge.strength * 0.6;
      const landed = arrival.get(edge.target);
      if (landed === undefined || edge.strength > landed.strength) {
        arrival.set(edge.target, {
          rate: spikeSpeed,
          phase: spikeSeed,
          strength: edge.strength,
        });
      }

      const count = Math.max(6, Math.round((raw[edgeIdx] ?? 6) * scale));
      const midpoint = a.clone().add(b).multiplyScalar(0.5);
      this.edgeIndex.push({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        midpoint: midpoint.clone(),
      });
      this.couple(edge.source, edge.target);

      // Routing. A tract does not take the short way: association fibres bow
      // outward and up through the white matter, and fibres that cross between
      // hemispheres dive to the midline and arch over it the way the corpus
      // callosum does. Straight chords between points are precisely what made
      // the earlier render read as string rather than as anatomy.
      const crosses = a.x >= 0 !== b.x >= 0;
      const waypoints: Vector3[] = [a.clone()];
      if (crosses) {
        const callosal = new Vector3(0, radius * 0.2, midpoint.z * 0.55);
        waypoints.push(
          a.clone().lerp(callosal, 0.55).setY(Math.max(a.y, callosal.y) * 0.72 + radius * 0.12),
          callosal,
          b.clone().lerp(callosal, 0.55).setY(Math.max(b.y, callosal.y) * 0.72 + radius * 0.12),
        );
      } else {
        const bow = midpoint.clone().multiplyScalar(0.62);
        bow.x += (a.x >= 0 ? 1 : -1) * radius * 0.2;
        bow.y += radius * 0.16;
        waypoints.push(a.clone().lerp(bow, 0.5), bow, b.clone().lerp(bow, 0.5));
      }
      waypoints.push(b.clone());

      const spine = new CatmullRomCurve3(waypoints);
      const points = spine.getPoints(SEGMENTS);
      // One spread basis per edge, so every fibre in a bundle fans in the same
      // plane. Independent noise per fibre gives fuzz; a shared basis gives a
      // tract with visible internal structure.
      const [u, v] = basis(b.clone().sub(a).normalize());
      // Wider than it was, because the fibre count it has to hold went up: at
      // the old girth the extra streamlines landed on top of each other and
      // bought brightness instead of body. A tract should read as a ribbon
      // with internal structure, which is what a bundle of axons looks like.
      const girth = radius * (0.062 + edge.strength * 0.12);

      for (let fibre = 0; fibre < count; fibre += 1) {
        // Uniform over the disc, not over (angle, radius) — otherwise every
        // bundle is dense at its axis and hollow at its rim.
        const angle = random() * Math.PI * 2;
        const offset = Math.sqrt(random());
        const lateral = u
          .clone()
          .multiplyScalar(Math.cos(angle) * offset)
          .add(v.clone().multiplyScalar(Math.sin(angle) * offset * 0.7))
          .multiplyScalar(girth);
        const wobble = 0.35 + random() * 0.65;

        const seed = random();
        // Where this tract sits on the time lapse. `recency` already is that
        // number: 0 at the far end of the window, 1 for a tract carrying work
        // today. It used to be a decorative growth order derived from the
        // bundle index, which grew the picture in an order nothing in the data
        // supported.
        const revealAt = edge.recency;
        // Recent activity still reads brighter, but old, valid couplings must
        // remain visible rather than disappearing into the void.
        const saturation = 0.35 + edge.recency * 0.65;

        const path: Vector3[] = points.map((point, index) => {
          const t = index / SEGMENTS;
          // Fibres converge on the parcel and fan through the white matter:
          // the profile is near zero at both terminals and widest in between.
          const profile = 0.14 + 0.86 * Math.sin(Math.PI * t);
          const drift =
            Math.sin(t * 7.0 + seed * 12.0) * girth * 0.22 * wobble * Math.sin(Math.PI * t);
          return point
            .clone()
            .addScaledVector(lateral, profile)
            .addScaledVector(u, drift);
        });

        for (let index = 0; index < path.length - 1; index += 1) {
          const p0 = path[index] as Vector3;
          const p1 = path[index + 1] as Vector3;
          const tangent = p1.clone().sub(p0).normalize();

          // Direction coding, as in a DTI render.
          direction.setRGB(
            Math.abs(tangent.x),
            Math.abs(tangent.z),
            Math.abs(tangent.y),
          );
          // Direction remains in the fibre's texture, but bundle colour leads.
          // A DTI-dominant mix turned the signal field green and made the
          // prismatic group coding almost invisible at a glance.
          direction.lerp(tint, 0.76);
          direction.multiplyScalar(saturation);
          if (edge.origin === "latent") direction.multiplyScalar(0.72);

          // Each end of the segment carries its own position along the path.
          // Giving both ends the same value quantised the travelling spike to
          // the segment count and made it stutter.
          for (const step of [index, index + 1]) {
            const point = (step === index ? p0 : p1) as Vector3;
            vertices.push(point.x, point.y, point.z);
            colors.push(direction.r, direction.g, direction.b);
            ts.push(step / SEGMENTS);
            spikeSeeds.push(spikeSeed);
            speeds.push(spikeSpeed);
            reveals.push(revealAt);
            edgeAttr.push(edgeIdx);
            srcAttr.push(srcIdx);
            tgtAttr.push(tgtIdx);
          }
        }
      }
    });

    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(new Float32Array(vertices), 3));
    geometry.setAttribute("color", new BufferAttribute(new Float32Array(colors), 3));
    geometry.setAttribute("aT", new BufferAttribute(new Float32Array(ts), 1));
    geometry.setAttribute("aSeed", new BufferAttribute(new Float32Array(spikeSeeds), 1));
    geometry.setAttribute("aSpeed", new BufferAttribute(new Float32Array(speeds), 1));
    geometry.setAttribute("aReveal", new BufferAttribute(new Float32Array(reveals), 1));
    geometry.setAttribute("aEdge", new BufferAttribute(new Float32Array(edgeAttr), 1));
    geometry.setAttribute("aSrc", new BufferAttribute(new Float32Array(srcAttr), 1));
    geometry.setAttribute("aTgt", new BufferAttribute(new Float32Array(tgtAttr), 1));

    this.material = new ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      vertexColors: true,
      blending: AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uReveal: { value: this.epoch },
        uPulse: { value: this.pulse },
        // Held low deliberately, and lowered again each time the fibre budget
        // went up — 7,000, then 24,000, then 40,000. Additive light accumulates,
        // so total brightness is roughly count × opacity: the only way to draw
        // several times as many streamlines without putting every hub at pure
        // white is to make each one contribute proportionally less. This is the
        // knob that controls brightness; `MAX_FIBRES` controls density.
        // Conflating the two is what previously led to the count being cut
        // instead.
        uOpacity: { value: 0.13 },
        uSelEdge: { value: -1 },
        uSelNode: { value: -1 },
      },
    });

    this.fibres = new LineSegments(geometry, this.material);
    this.scene.add(this.fibres);

    /*
     * Nodes.
     *
     * The soma is light, not geometry: one additive sprite carrying a bright
     * core in its bundle's hue and a wide corona whose colour is completion
     * rate, so a failing cell burns warm without gaining a second object. The
     * sphere mesh survives only as the raycast target — three.js hit-tests a
     * mesh whether or not it is drawn — because picking a `Points` cloud with a
     * screen-space threshold is far less reliable than picking geometry.
     *
     * Size carries run volume over a deliberately narrow range: the old range
     * let a busy IQ Cell grow large enough to swallow the tracts converging on
     * it, which is exactly the information the size was meant to sit beside.
     */
    const dummy = new Object3D();
    const unit = radius * 0.026;
    const nodeGeometry = new SphereGeometry(unit, 14, 10);
    const nodeMaterial = new MeshBasicMaterial();
    const nodes = new InstancedMesh(nodeGeometry, nodeMaterial, graph.nodes.length);
    nodes.instanceMatrix.setUsage(DynamicDrawUsage);
    // Pick target only. It is kept in the scene so `intersectObject` can reach
    // it, and never drawn, so it cannot go back to being a faceted ball.
    nodes.visible = false;

    const maxRuns = Math.max(...graph.nodes.map((node) => node.runs), 1);
    const swatch = new Color();
    const glow = new Color();
    const ionWhite = new Color(0xe0e7ff);

    const somaPos: number[] = [];
    const somaColor: number[] = [];
    const somaGlow: number[] = [];
    const somaSize: number[] = [];
    const somaRate: number[] = [];
    const somaPhase: number[] = [];
    const somaReveal: number[] = [];
    /** Sprite diameter in world units, which is what a label has to clear. */
    const spriteSize = new Map<string, number>();

    graph.nodes.forEach((node, index) => {
      const at = positions.get(node.id) as Vector3;
      const size = 0.8 + (node.runs / maxRuns) * 1.0;
      dummy.position.copy(at);
      dummy.scale.setScalar(size);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      nodes.setMatrixAt(index, dummy.matrix);

      swatch.setHSL((bundleHue.get(node.bundleId ?? "") ?? 210) / 360, 0.86, 0.64);
      glow.copy(swatch).lerp(ionWhite, 0.26 + node.completionRate * 0.22);

      const landing = arrival.get(node.id);
      somaPos.push(at.x, at.y, at.z);
      somaColor.push(swatch.r, swatch.g, swatch.b);
      somaGlow.push(glow.r, glow.g, glow.b);
      // World diameter of the whole sprite. The core occupies `uCore` of it,
      // so the visible cell body stays close to the old sphere while the
      // corona finally has somewhere to be.
      somaSize.push(unit * size * 6);
      spriteSize.set(node.id, unit * size * 6);
      somaRate.push(landing?.rate ?? 0);
      somaPhase.push(landing?.phase ?? 0);
      // The same clock the tracts run on, so a cell and the tracts into it
      // arrive together rather than the picture assembling in two passes.
      somaReveal.push(arrivalOf(node.lastRunDaysAgo));
    });

    nodes.instanceMatrix.needsUpdate = true;

    this.nodesMesh = nodes;
    this.scene.add(nodes);

    const somaGeometry = new BufferGeometry();
    somaGeometry.setAttribute("position", new BufferAttribute(new Float32Array(somaPos), 3));
    somaGeometry.setAttribute("color", new BufferAttribute(new Float32Array(somaColor), 3));
    somaGeometry.setAttribute("aGlow", new BufferAttribute(new Float32Array(somaGlow), 3));
    somaGeometry.setAttribute("aSize", new BufferAttribute(new Float32Array(somaSize), 1));
    somaGeometry.setAttribute("aRate", new BufferAttribute(new Float32Array(somaRate), 1));
    somaGeometry.setAttribute("aPhase", new BufferAttribute(new Float32Array(somaPhase), 1));
    somaGeometry.setAttribute("aReveal", new BufferAttribute(new Float32Array(somaReveal), 1));

    this.somaMaterial = new ShaderMaterial({
      vertexShader: SOMA_VERTEX,
      fragmentShader: SOMA_FRAGMENT,
      transparent: true,
      depthWrite: false,
      vertexColors: true,
      blending: AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uPulse: { value: this.pulse },
        uReveal: { value: this.epoch },
        uProject: { value: this.projectionFactor() },
        uOpacity: { value: 0.82 },
        uCore: { value: 0.32 },
      },
    });
    const somata = new Points(somaGeometry, this.somaMaterial);
    somata.renderOrder = 2;
    somata.frustumCulled = false;
    this.somaPoints = somata;
    this.scene.add(somata);

    /*
     * The envelope.
     *
     * A barely-there inner surface behind the fibres. Without it the tracts
     * float in nothing and the eye has no shape to hang them on; with it the
     * silhouette of the cortex is legible even where no bundle happens to run.
     * Back faces only, no depth write, so it never occludes a fibre — it is
     * atmosphere rather than an object.
     */
    const shellMaterial = new MeshBasicMaterial({
      color: new Color(0x4a6ea8),
      transparent: true,
      opacity: 0.07,
      side: BackSide,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    const shell = new Mesh(new SphereGeometry(radius, 40, 28), shellMaterial);
    shell.scale.set(CORTEX.x * 1.04, CORTEX.y * 1.04, CORTEX.z * 1.04);
    shell.renderOrder = -1;
    this.shellMesh = shell;
    this.scene.add(shell);

    // Drawn complete. The time lapse is what the transport is for; playing it
    // unasked means the first thing a reader sees after pressing Analyse
    // is a picture that is not there yet.
    this.buildLabels(graph, positions, spriteSize);
    this.stopTimeLapse();
    this.zoomToFit();
  }

  /** Both directions: selecting either end of a tract should name the other. */
  private couple(source: string, target: string): void {
    const forward = this.adjacency.get(source) ?? new Set<string>();
    forward.add(target);
    this.adjacency.set(source, forward);
    const back = this.adjacency.get(target) ?? new Set<string>();
    back.add(source);
    this.adjacency.set(target, back);
  }

  /**
   * One span per node, built once.
   *
   * The text and the box are measured here and never again. A label's width
   * cannot change without its text changing, and reading `offsetWidth` inside
   * the render loop would force the browser to lay the page out sixty times a
   * second for an answer that is already known.
   */
  private buildLabels(
    graph: ConnectomeGraph,
    positions: Map<string, Vector3>,
    spriteSize: Map<string, number>,
  ): void {
    const layer = this.labelLayer;
    if (layer === null) return;

    const text = shortLabelsFor(graph.nodes);
    this.labels = [];
    this.labelsById.clear();

    for (const node of graph.nodes) {
      const at = positions.get(node.id);
      if (at === undefined) continue;
      const element = document.createElement("span");
      element.className = "map-label";
      element.textContent = text.get(node.id) ?? node.name;
      // The short form is what fits; the full name is what was asked for.
      element.title = node.name;
      element.style.display = "none";
      layer.appendChild(element);
      const label: NodeLabel = {
        id: node.id,
        at,
        element,
        runs: node.runs,
        sprite: spriteSize.get(node.id) ?? 0,
        reveal: arrivalOf(node.lastRunDaysAgo),
        width: 0,
        height: 0,
        shown: false,
      };
      this.labels.push(label);
      this.labelsById.set(node.id, label);
    }

    // Measured with the labels laid out but hidden by `display: none`, which
    // reports zero. Shown for the measure, hidden again, in one pass so the
    // page is laid out twice rather than twice per label.
    for (const label of this.labels) label.element.style.visibility = "hidden";
    for (const label of this.labels) label.element.style.display = "";
    for (const label of this.labels) {
      label.width = label.element.offsetWidth;
      label.height = label.element.offsetHeight;
    }
    for (const label of this.labels) {
      label.element.style.display = "none";
      label.element.style.visibility = "";
      // A pane that is not on screen yet measures zero. Estimating from the
      // text is coarse, but a zero-width box overlaps nothing, which would let
      // every label pile up in one corner.
      if (label.width === 0) label.width = (label.element.textContent?.length ?? 8) * 6.4 + 14;
      if (label.height === 0) label.height = 18;
    }

    // Busiest first. Two things fall out of the order: it is the order the
    // resting set is filled in, and it is the order collisions are settled in.
    this.labels.sort((a, b) => b.runs - a.runs);
  }

  select(nodeId: string | null, edgeId: string | null): void {
    this.selectedNodeId = nodeId;
    this.selectedEdgeId = edgeId;
    if (this.material === null) return;
    setUniform(this.material, "uSelNode", nodeId === null ? -1 : this.nodeIds.indexOf(nodeId));
    setUniform(
      this.material,
      "uSelEdge",
      edgeId === null ? -1 : this.edgeIndex.findIndex((edge) => edge.id === edgeId),
    );
  }

  zoomToFit(): void {
    this.desired = null;
    this.target.copy(this.framingTarget());
    this.spherical.radius = this.fitRadius;
  }

  /**
   * Back to the pose the picture opened in.
   *
   * Distinct from {@link zoomToFit}, which re-frames from wherever the camera
   * is now and leaves the orientation alone. Dragging this surface *rotates* it
   * rather than panning it, and the tour flies the camera to each stop, so
   * after a minute of either there is no way to recover the view the reader was
   * shown first — fitting again lands on the same graph seen from an angle they
   * did not choose. This restores the angles too, which is the only thing that
   * makes "the opening view" a place you can return to.
   */
  resetView(): void {
    this.desired = null;
    this.target.copy(this.framingTarget());
    this.spherical.radius = this.fitRadius;
    this.spherical.theta = HOME_THETA;
    this.spherical.phi = HOME_PHI;
  }

  /**
   * Where the camera looks in order to put the *ink* in the middle of the
   * pane, which is not the same point as the middle of the node cloud. Shared
   * by every re-framing path so "fit" and "back to the opening view" cannot
   * disagree about where the middle is.
   */
  private framingTarget(): Vector3 {
    return this.centreOfGraph().addScaledVector(screenDown(), this.fitRadius * FRAME_LIFT);
  }

  /**
   * Point the camera at one node or one tract and hold it there.
   *
   * This is what the tour drives. It eases rather than cuts so the viewer keeps
   * their bearings — a hard jump between two stops reads as a new picture, not
   * as a move across the same one.
   */
  focusOn(nodeId: string | null, edgeId: string | null): void {
    const at =
      nodeId !== null
        ? (this.nodePositions.get(nodeId) ?? null)
        : edgeId !== null
          ? (this.edgeIndex.find((edge) => edge.id === edgeId)?.midpoint ?? null)
          : null;
    if (at === null) {
      this.zoomToFit();
      return;
    }
    this.desired = { target: at.clone(), radius: Math.max(2.6, this.fitRadius * 0.52) };
  }

  private centreOfGraph(): Vector3 {
    const centre = new Vector3();
    if (this.nodePositions.size === 0) return centre;
    for (const point of this.nodePositions.values()) centre.add(point);
    return centre.divideScalar(this.nodePositions.size);
  }

  /**
   * The camera distance at which the graph fills the pane.
   *
   * A bounding sphere cannot answer this. The node cloud is not round and the
   * pane is not square, so framing a sphere satisfies whichever axis is
   * longest and leaves the other one short. That is what put the graph in a
   * column down the middle of a landscape pane, with the top of it clipped:
   * the sphere's radius was set by the vertical extent and the horizontal
   * extent never got a say.
   *
   * So both screen axes are measured separately, in the camera's own basis, at
   * whatever angle it is currently on. The distance is whichever of the two
   * constraints is tighter. Only the horizontal one carries `aspect`, because
   * a perspective camera's field of view is vertical and the horizontal field
   * is derived from it.
   */
  private measureFit(centre: Vector3): number {
    if (this.nodePositions.size === 0) return 3.2;

    // The same spherical-to-cartesian the render loop uses to place the
    // camera, minus the radius. Reading it from `this.spherical` rather than
    // from the camera means the fit is correct on the frame the graph is
    // built, before the camera has been moved for the first time.
    const { theta, phi } = this.spherical;
    const forward = new Vector3(
      Math.sin(phi) * Math.sin(theta),
      Math.cos(phi),
      Math.sin(phi) * Math.cos(theta),
    )
      .normalize()
      .negate();
    const right = new Vector3().crossVectors(forward, this.camera.up);
    // Degenerate only if the camera is looking straight down its own up axis,
    // which the orbit clamp prevents; the fallback keeps the basis finite
    // rather than producing NaN positions if it ever does.
    if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
    right.normalize();
    const up = new Vector3().crossVectors(right, forward).normalize();

    let halfWidth = 0;
    let halfHeight = 0;
    const offset = new Vector3();
    for (const point of this.nodePositions.values()) {
      offset.copy(point).sub(centre);
      halfWidth = Math.max(halfWidth, Math.abs(offset.dot(right)));
      halfHeight = Math.max(halfHeight, Math.abs(offset.dot(up)));
    }

    const halfFov = Math.tan(((this.camera.fov * Math.PI) / 180) / 2);
    const aspect = Math.max(0.2, this.camera.aspect);
    // Room for what a node draws beyond its own centre: the soma corona, the
    // label beside it, and the fibre that bows outside the pair it joins.
    // 1.16, where the sphere fit used the equivalent of 2.0 — the rest of that
    // was background.
    const margin = 1.16;
    return Math.max(
      3.2,
      Math.max(halfHeight / halfFov, halfWidth / (halfFov * aspect)) * margin,
    );
  }

  resize(): void {
    const parent = this.canvas.parentElement;
    const width = parent?.clientWidth ?? this.canvas.clientWidth ?? 640;
    const height = parent?.clientHeight ?? this.canvas.clientHeight ?? 480;
    this.renderer.setSize(width, height, false);
    this.viewport = { width: Math.max(1, width), height: Math.max(1, height) };
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();

    // The fit depends on the pane's shape, so a pane that is dragged wider has
    // a different one. Scaling the live radius by the same factor keeps the
    // reader's own zoom while still filling the new shape; recomputing the fit
    // and leaving the camera alone would hold the framing of the old pane.
    if (this.nodePositions.size === 0) return;
    const previous = this.fitRadius;
    this.fitRadius = this.measureFit(this.centreOfGraph());
    if (previous > 0) this.spherical.radius *= this.fitRadius / previous;
  }

  /**
   * Pixels per world unit at one unit of depth.
   *
   * `gl_PointSize` is in device pixels, so turning a world-space diameter into
   * one needs the drawing buffer's own height and the camera's field of view.
   * A hardcoded constant here is what made the soma corona render at roughly a
   * fifth of its size and disappear inside the node it surrounds.
   */
  private projectionFactor(): number {
    const buffer = this.renderer.getDrawingBufferSize(new Vector2());
    const fov = (this.camera.fov * Math.PI) / 180;
    return buffer.y / (2 * Math.tan(fov / 2));
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.clear();
    this.renderer.dispose();
  }

  // ── internals ──────────────────────────────────────────────────────────

  private clear(): void {
    for (const object of [this.fibres, this.nodesMesh, this.somaPoints, this.shellMesh]) {
      if (object === null) continue;
      this.scene.remove(object);
      object.geometry.dispose();
      const material = object.material;
      if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
      else material.dispose();
    }
    this.fibres = null;
    this.nodesMesh = null;
    this.somaPoints = null;
    this.shellMesh = null;
    this.material = null;
    this.somaMaterial = null;
    this.edgeIndex = [];
    this.nodeIds = [];
    this.labelLayer?.replaceChildren();
    this.labels = [];
    this.labelsById.clear();
    this.adjacency.clear();
  }

  private bind(): void {
    let dragging = false;
    let panning = false;
    let last = { x: 0, y: 0 };
    let moved = 0;

    this.canvas.addEventListener("pointerdown", (event) => {
      dragging = true;
      panning = event.shiftKey || event.button === 1;
      moved = 0;
      last = { x: event.clientX, y: event.clientY };
      this.autoRotate = false;
      // Taking hold of the camera ends any automatic move on it.
      this.desired = null;
      this.canvas.setPointerCapture(event.pointerId);
    });

    this.canvas.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      const dx = event.clientX - last.x;
      const dy = event.clientY - last.y;
      moved += Math.abs(dx) + Math.abs(dy);
      last = { x: event.clientX, y: event.clientY };
      if (panning) {
        this.target.x -= dx * 0.006 * this.spherical.radius * 0.3;
        this.target.y += dy * 0.006 * this.spherical.radius * 0.3;
      } else {
        this.spherical.theta -= dx * 0.005;
        this.spherical.phi = Math.min(
          Math.PI - 0.12,
          Math.max(0.12, this.spherical.phi - dy * 0.005),
        );
      }
    });

    this.canvas.addEventListener("pointerup", (event) => {
      dragging = false;
      this.canvas.releasePointerCapture(event.pointerId);
      // A drag orbits; a click picks.
      if (moved < 4) this.pick(event);
    });

    this.canvas.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        this.autoRotate = false;
        this.desired = null;
        this.spherical.radius = Math.min(
          22,
          Math.max(2.2, this.spherical.radius * Math.exp(event.deltaY * 0.0012)),
        );
      },
      { passive: false },
    );
  }

  private pick(event: PointerEvent): void {
    const box = this.canvas.getBoundingClientRect();
    const ndc = new Vector2(
      ((event.clientX - box.left) / box.width) * 2 - 1,
      -((event.clientY - box.top) / box.height) * 2 + 1,
    );

    if (this.nodesMesh !== null) {
      this.raycaster.setFromCamera(ndc, this.camera);
      const hits = this.raycaster.intersectObject(this.nodesMesh, false);
      const instance = hits[0]?.instanceId;
      if (instance !== undefined) {
        this.callbacks.onPickNode(this.nodeIds[instance] ?? null);
        return;
      }
    }

    // No node under the cursor: fall back to the nearest fibre bundle by its
    // projected midpoint, which is cheap and accurate enough to select a tract.
    let best: { id: string; distance: number } | null = null;
    for (const edge of this.edgeIndex) {
      const projected = edge.midpoint.clone().project(this.camera);
      const distance = Math.hypot(projected.x - ndc.x, projected.y - ndc.y);
      if (best === null || distance < best.distance) best = { id: edge.id, distance };
    }
    if (best !== null && best.distance < 0.06) {
      this.callbacks.onPickEdge(best.id);
      return;
    }
    this.callbacks.onPickNode(null);
    this.callbacks.onPickEdge(null);
  }

  private loop = (): void => {
    if (this.disposed) return;
    this.frame = requestAnimationFrame(this.loop);
    this.clock += 0.016;

    if (this.playingLapse) {
      this.epoch = Math.min(1, this.epoch + LAPSE_STEP);
      if (this.epoch >= 1) this.playingLapse = false;
      this.callbacks.onEpoch?.(this.epoch);
    }
    if (this.autoRotate) this.spherical.theta += 0.0012;

    // Ease toward the tour's stop. The step is frame-proportional and small, so
    // the move is legible rather than a cut, and it converges instead of
    // oscillating around the target.
    if (this.desired !== null) {
      this.target.lerp(this.desired.target, 0.06);
      this.spherical.radius += (this.desired.radius - this.spherical.radius) * 0.06;
    }

    if (this.material !== null) {
      setUniform(this.material, "uTime", this.clock);
      // Linear, deliberately. The reveal used to be eased because it was a
      // flourish; it is a clock now, and easing a clock is a lie about when
      // things happened.
      setUniform(this.material, "uReveal", this.epoch);
      setUniform(this.material, "uPulse", this.pulse);
    }

    if (this.somaMaterial !== null) {
      setUniform(this.somaMaterial, "uTime", this.clock);
      setUniform(this.somaMaterial, "uPulse", this.pulse);
      setUniform(this.somaMaterial, "uReveal", this.epoch);
      // Point size is in device pixels, so the projection has to follow the
      // drawing buffer the renderer is actually using rather than a constant
      // captured once at build time.
      setUniform(this.somaMaterial, "uProject", this.projectionFactor());
    }

    const { radius, theta, phi } = this.spherical;
    this.camera.position.set(
      this.target.x + radius * Math.sin(phi) * Math.sin(theta),
      this.target.y + radius * Math.cos(phi),
      this.target.z + radius * Math.sin(phi) * Math.cos(theta),
    );
    this.camera.lookAt(this.target);
    this.renderer.render(this.scene, this.camera);
    // After `lookAt`: the names are placed by projecting through the camera,
    // and projecting through last frame's camera puts every label a step
    // behind the node it belongs to, which reads as the text sliding.
    this.drawLabels();
  };

  /**
   * Place the names for this frame.
   *
   * Three rules, in order.
   *
   * *Which* names: with a node selected, that node and everything coupled to
   * it, so the chat can cite a cell and the map answers where it is and what
   * it touches. With a tract selected, its two ends. With nothing selected,
   * the busiest cells up to {@link RESTING_LABELS}.
   *
   * *Whether* a name can be drawn at all: a node behind the camera, outside
   * the pane, or not yet arrived in the time lapse has no label.
   *
   * *Where*: at the node, and dropped if its box overlaps one already placed.
   * Overlapping labels are worse than a missing one — two half-legible names
   * on top of each other identify neither node. Earlier in the order wins, so
   * the selected cell keeps its name and a background cell loses it.
   */
  private drawLabels(): void {
    if (this.labelLayer === null || this.labels.length === 0) return;

    const focus = this.labelFocus();
    const order = focus ?? this.labels;
    const budget = focus === null ? RESTING_LABELS : order.length;
    const { width, height } = this.viewport;
    // Once per frame, not once per label: both of these ask the renderer for
    // its buffer size.
    const project = this.projectionFactor() / this.renderer.getPixelRatio();
    const placed: LabelBox[] = [];
    const named = new Set<string>();

    for (const label of order) {
      if (named.size >= budget) break;
      if (!this.placeLabel(label, width, height, project, placed)) continue;
      named.add(label.id);
    }
    for (const label of this.labels) if (!named.has(label.id)) this.hideLabel(label);
  }

  /**
   * The names the current selection asks for, or `null` for "nothing is
   * selected, fall back to the busiest cells".
   *
   * The selected cell comes first so that when its label and a neighbour's
   * collide, the one the reader asked about is the one that survives.
   */
  private labelFocus(): NodeLabel[] | null {
    if (this.selectedNodeId !== null) {
      const chosen = this.labelsById.get(this.selectedNodeId);
      if (chosen === undefined) return null;
      const neighbours = [...(this.adjacency.get(this.selectedNodeId) ?? [])]
        .map((id) => this.labelsById.get(id))
        .filter((label): label is NodeLabel => label !== undefined)
        .sort((a, b) => b.runs - a.runs);
      return [chosen, ...neighbours];
    }
    if (this.selectedEdgeId !== null) {
      const edge = this.edgeIndex.find((entry) => entry.id === this.selectedEdgeId);
      if (edge === undefined) return null;
      return [this.labelsById.get(edge.source), this.labelsById.get(edge.target)].filter(
        (label): label is NodeLabel => label !== undefined,
      );
    }
    return null;
  }

  /** Put one name under its node, or report that it cannot be drawn. */
  private placeLabel(
    label: NodeLabel,
    width: number,
    height: number,
    project: number,
    placed: LabelBox[],
  ): boolean {
    // A cell the time lapse has not reached yet is not on the picture, so
    // naming it would label an empty patch of cortex.
    if (label.reveal > this.epoch + 1e-3) return false;

    this.projected.copy(label.at).project(this.camera);
    // Behind the camera. `project` still returns coordinates there, mirrored,
    // which is how names end up on the far side of the map from their node.
    if (this.projected.z > 1) return false;

    const x = (this.projected.x * 0.5 + 0.5) * width;
    const y = (-this.projected.y * 0.5 + 0.5) * height;
    // Below the soma, not below the node's centre. A busy cell's sprite is
    // tens of pixels across and grows as the camera moves in, so a fixed drop
    // puts the name inside the glow on exactly the cells worth naming — which
    // is where the first cut of this landed.
    const distance = Math.max(0.1, this.camera.position.distanceTo(label.at));
    const soma = (label.sprite * project) / distance;
    const drop = LABEL_GAP + Math.min(soma * SOMA_CORE, 64);
    const box: LabelBox = {
      left: x - label.width / 2,
      top: y + drop,
      right: x + label.width / 2,
      bottom: y + drop + label.height,
    };
    if (box.right < 0 || box.left > width || box.bottom < 0 || box.top > height) return false;
    if (placed.some((other) => overlaps(box, other))) return false;

    placed.push(box);
    // Rounded: a label on a half pixel is a blurry label.
    label.element.style.transform = `translate3d(${Math.round(box.left)}px, ${Math.round(box.top)}px, 0)`;
    if (!label.shown) {
      label.element.style.display = "";
      label.shown = true;
    }
    label.element.classList.toggle("on", label.id === this.selectedNodeId);
    return true;
  }

  /** Only writes when the state changes: a style write per frame per label costs. */
  private hideLabel(label: NodeLabel): void {
    if (!label.shown) return;
    label.element.style.display = "none";
    label.shown = false;
  }
}

/**
 * The renderer is optional: the caller falls back to the table view.
 *
 * Answered once and remembered, and the probe context is released as soon as
 * it has answered. Both matter: a browser allows a small number of live WebGL
 * contexts — around sixteen — and this used to be called from a `useState`
 * *initial value* rather than a lazy initialiser, so it ran on every render
 * and leaked a context each time. Enough renders and the browser starts
 * dropping the oldest context, which is the map's own: the picture went black,
 * the console filled with "Too many active WebGL contexts", and the window
 * eventually died.
 */
let webglSupport: boolean | null = null;

export const webglAvailable = (): boolean => {
  if (webglSupport !== null) return webglSupport;
  try {
    const probe = document.createElement("canvas");
    const context =
      (probe.getContext("webgl2") as WebGLRenderingContext | null) ??
      (probe.getContext("webgl") as WebGLRenderingContext | null);
    // Handing the context back is what stops the probe counting against the
    // budget for the life of the window.
    context?.getExtension("WEBGL_lose_context")?.loseContext();
    webglSupport = context !== null;
  } catch {
    webglSupport = false;
  }
  return webglSupport;
};

