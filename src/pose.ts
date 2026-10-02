/**
 * Body poses in the OpenPose-18 format that pose detectors, ControlNets and Qwen-Image references
 * understand: per person 18 [x, y, confidence] points in pixels of a `width × height` frame.
 * Pure functions (no DOM) apart from `drawPose`, which draws on any 2D canvas context.
 */
export type Keypoint = [number, number, number];
export interface PoseSpec {
  width: number;
  height: number;
  people: Keypoint[][];
}

export const JOINTS = [
  "Nose", "Neck", "Right shoulder", "Right elbow", "Right wrist", "Left shoulder", "Left elbow", "Left wrist",
  "Right hip", "Right knee", "Right ankle", "Left hip", "Left knee", "Left ankle", "Right eye", "Left eye",
  "Right ear", "Left ear",
] as const;
export const LIMBS: [number, number][] = [
  [1, 2], [1, 5], [2, 3], [3, 4], [5, 6], [6, 7], [1, 8], [8, 9], [9, 10], [1, 11], [11, 12], [12, 13],
  [1, 0], [0, 14], [14, 16], [0, 15], [15, 17],
];
export const COLORS: [number, number, number][] = [
  [255, 0, 0], [255, 85, 0], [255, 170, 0], [255, 255, 0], [170, 255, 0], [85, 255, 0], [0, 255, 0],
  [0, 255, 85], [0, 255, 170], [0, 255, 255], [0, 170, 255], [0, 85, 255], [0, 0, 255], [85, 0, 255],
  [170, 0, 255], [255, 0, 255], [255, 0, 170], [255, 0, 85],
];
/** Left/right pairs swapped when mirroring. */
const PAIRS: [number, number][] = [[2, 5], [3, 6], [4, 7], [8, 11], [9, 12], [10, 13], [14, 15], [16, 17]];

/** Presets in a 1 × 2 box (x, y as fractions), image-left = the figure's right side (facing the viewer). */
type Preset = [number, number][];
const head = (nx: number, ny: number): [number, number][] => [
  [nx - 0.02, ny - 0.015], [nx + 0.02, ny - 0.015], [nx - 0.05, ny - 0.005], [nx + 0.05, ny - 0.005],
];
function preset(points: [number, number][], nose: [number, number]): Preset {
  const [re, le, rr, lr] = head(nose[0], nose[1]);
  return [nose, ...points, re, le, rr, lr];
}
export const PRESETS: Record<string, Preset> = {
  Standing: preset([[0.5, 0.2], [0.38, 0.21], [0.33, 0.36], [0.31, 0.5], [0.62, 0.21], [0.67, 0.36], [0.69, 0.5],
    [0.43, 0.5], [0.43, 0.7], [0.43, 0.9], [0.57, 0.5], [0.57, 0.7], [0.57, 0.9]], [0.5, 0.11]),
  Walking: preset([[0.5, 0.2], [0.38, 0.21], [0.4, 0.36], [0.46, 0.48], [0.62, 0.21], [0.6, 0.36], [0.55, 0.47],
    [0.44, 0.5], [0.36, 0.69], [0.3, 0.88], [0.56, 0.5], [0.6, 0.7], [0.66, 0.9]], [0.5, 0.11]),
  Running: preset([[0.52, 0.22], [0.42, 0.23], [0.34, 0.33], [0.4, 0.43], [0.62, 0.22], [0.7, 0.3], [0.76, 0.22],
    [0.47, 0.5], [0.3, 0.6], [0.22, 0.78], [0.58, 0.5], [0.66, 0.66], [0.56, 0.84]], [0.55, 0.13]),
  "Arms up": preset([[0.5, 0.24], [0.38, 0.25], [0.32, 0.14], [0.3, 0.03], [0.62, 0.25], [0.68, 0.14], [0.7, 0.03],
    [0.43, 0.53], [0.43, 0.72], [0.43, 0.92], [0.57, 0.53], [0.57, 0.72], [0.57, 0.92]], [0.5, 0.15]),
  "T-pose": preset([[0.5, 0.2], [0.4, 0.21], [0.25, 0.21], [0.1, 0.21], [0.6, 0.21], [0.75, 0.21], [0.9, 0.21],
    [0.43, 0.5], [0.43, 0.7], [0.43, 0.9], [0.57, 0.5], [0.57, 0.7], [0.57, 0.9]], [0.5, 0.11]),
  Waving: preset([[0.5, 0.2], [0.38, 0.21], [0.33, 0.36], [0.32, 0.5], [0.62, 0.21], [0.74, 0.14], [0.76, 0.02],
    [0.43, 0.5], [0.43, 0.7], [0.43, 0.9], [0.57, 0.5], [0.57, 0.7], [0.57, 0.9]], [0.5, 0.11]),
  Sitting: preset([[0.5, 0.36], [0.38, 0.37], [0.35, 0.5], [0.4, 0.6], [0.62, 0.37], [0.65, 0.5], [0.6, 0.6],
    [0.43, 0.64], [0.3, 0.66], [0.32, 0.88], [0.57, 0.64], [0.44, 0.67], [0.46, 0.89]], [0.5, 0.27]),
};

/** A preset scaled into a frame: the figure fills ~90 % of the height, centred. */
export function presetPerson(name: string, width: number, height: number): Keypoint[] {
  const points = PRESETS[name] ?? PRESETS.Standing;
  const boxH = Math.min(height * 0.9, width * 1.8);
  const boxW = boxH / 2;
  const left = (width - boxW) / 2,
    top = (height - boxH) / 2;
  return points.map(([x, y]) => [round(left + x * boxW), round(top + y * boxH), 1]);
}

export function presetPose(name: string, width: number, height: number): PoseSpec {
  return { width, height, people: [presetPerson(name, width, height)] };
}

const round = (v: number) => Math.round(v * 10) / 10;

/** Mirror a person horizontally (left and right joints swap so the colours stay correct). */
export function mirrorPerson(person: Keypoint[], width: number): Keypoint[] {
  const out = person.map(([x, y, c]) => [round(width - x), y, c] as Keypoint);
  for (const [a, b] of PAIRS) [out[a], out[b]] = [out[b], out[a]];
  return out;
}

/** The same pose in another frame size: uniform scale, centred (aspect of the figure kept). */
export function fitPose(pose: PoseSpec, width: number, height: number): PoseSpec {
  const s = Math.min(width / pose.width, height / pose.height);
  const dx = (width - pose.width * s) / 2,
    dy = (height - pose.height * s) / 2;
  return {
    width,
    height,
    people: pose.people.map((p) => p.map(([x, y, c]) => [round(x * s + dx), round(y * s + dy), c] as Keypoint)),
  };
}

/** Keep only plausible poses: 18 finite points per person, coordinates clamped to the frame. */
export function cleanPose(value: unknown): PoseSpec | null {
  const v = value as PoseSpec;
  if (!v || typeof v !== "object" || !Array.isArray(v.people)) return null;
  const width = Number(v.width),
    height = Number(v.height);
  if (!(width >= 16 && width <= 8192 && height >= 16 && height <= 8192)) return null;
  const people = v.people
    .slice(0, 6)
    .filter((p) => Array.isArray(p) && p.length === 18)
    .map((p) =>
      p.map((k) => {
        const [x, y, c] = Array.isArray(k) ? k.map(Number) : [0, 0, 0];
        return [
          Number.isFinite(x) ? Math.max(0, Math.min(width, x)) : 0,
          Number.isFinite(y) ? Math.max(0, Math.min(height, y)) : 0,
          Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 0,
        ] as Keypoint;
      }),
    );
  return people.length ? { width, height, people } : null;
}

/** Nearest visible joint to (x, y) within `radius`, as [person, joint], or null. */
export function hitJoint(pose: PoseSpec, x: number, y: number, radius: number, threshold = 0.3): [number, number] | null {
  let best: [number, number] | null = null,
    bestD = radius * radius;
  pose.people.forEach((p, i) =>
    p.forEach(([px, py, c], j) => {
      if (c < threshold) return;
      const d = (px - x) ** 2 + (py - y) ** 2;
      if (d <= bestD) {
        bestD = d;
        best = [i, j];
      }
    }),
  );
  return best;
}

/** Draw the standard OpenPose skeleton (limbs at 60 % brightness, then joints) on a 2D context. */
export function drawPose(
  ctx: CanvasRenderingContext2D,
  pose: PoseSpec,
  options: { background?: boolean; scale?: number; threshold?: number; highlight?: [number, number] | null } = {},
) {
  const scale = options.scale ?? 1,
    threshold = options.threshold ?? 0.3;
  const stick = Math.max(2, Math.round((Math.min(pose.width, pose.height) / 160) * scale));
  if (options.background !== false) {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, pose.width * scale, pose.height * scale);
  }
  ctx.lineCap = "round";
  for (const person of pose.people) {
    LIMBS.forEach(([a, b], i) => {
      const pa = person[a],
        pb = person[b];
      if (!pa || !pb || pa[2] < threshold || pb[2] < threshold) return;
      const [r, g, bl] = COLORS[i].map((v) => Math.round(v * 0.6));
      ctx.strokeStyle = `rgb(${r},${g},${bl})`;
      ctx.lineWidth = stick * 2;
      ctx.beginPath();
      ctx.moveTo(pa[0] * scale, pa[1] * scale);
      ctx.lineTo(pb[0] * scale, pb[1] * scale);
      ctx.stroke();
    });
  }
  pose.people.forEach((person, i) =>
    person.forEach(([x, y, c], j) => {
      if (c < threshold) return;
      const [r, g, b] = COLORS[j];
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      const hot = options.highlight && options.highlight[0] === i && options.highlight[1] === j;
      ctx.beginPath();
      ctx.arc(x * scale, y * scale, hot ? stick * 2.2 : stick * 1.2, 0, Math.PI * 2);
      ctx.fill();
      if (hot) {
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }),
  );
}

/** The instruction that turns a skeleton reference into a pose constraint. */
export function poseInstruction(imageNumber: number, editing = false) {
  return editing
    ? `Change the body pose of the person in image 1 to exactly match the coloured stick-figure skeleton in image ${imageNumber}. ` +
        "Keep their identity, face, clothing, proportions and the background. Do not draw the skeleton."
    : `The subject's body pose must exactly match the coloured stick-figure skeleton in image ${imageNumber}. ` +
        "Do not draw the skeleton itself.";
}
