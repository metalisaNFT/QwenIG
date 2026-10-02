import { layerBounds } from "./geometry.ts";
import { parseAdjustments, type Adjustments } from "./adjustments.ts";
export const blendModes = [
  "normal",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "soft-light",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
] as const;
export type Kind = "image" | "text" | "note" | "prompt" | "mask" | "video";
export interface TextStyle {
  fontFamily: "Arial" | "Georgia" | "Courier New";
  fontSize: number;
  color: string;
  bold: boolean;
  italic: boolean;
  align: "left" | "center" | "right";
  lineHeight: number;
}
export const defaultTextStyle: TextStyle = {
  fontFamily: "Arial",
  fontSize: 64,
  color: "#e8eae4",
  bold: false,
  italic: false,
  align: "left",
  lineHeight: 1.2,
};
export interface Settings {
  prompt: string;
  negative_prompt: string;
  width: number;
  height: number;
  steps: number;
  guidance: number;
  seed: number;
  /** RGBA output with a transparent background (engine capability "transparent"). */
  transparent?: boolean;
}
export const editOperations = [
  "edit",
  "inpaint",
  "outpaint",
  "image-to-image",
  "variations",
] as const;
export interface Generation extends Settings {
  reference_count?: number;
  kind?: "image" | "edit" | "video" | "speech" | "music" | "upscale";
  operation?: (typeof editOperations)[number];
  strength?: number;
  model: string;
  jobId: string;
  createdAt: string;
  runner?: string;
  runnerRevision?: string;
  demo?: boolean;
  /** Upscales: the factor, and the result's pixel size (width/height stay the source's generation settings). */
  scale?: number;
  outputWidth?: number;
  outputHeight?: number;
}
/**
 * Metadata for an upscaled image: the source's generation settings (so it stays a valid, reusable
 * generation record) plus what the upscale did.
 */
export function upscaleMetadata(
  job: { scale?: number; width: number; height: number; model: string; jobId: string; createdAt: string; demo?: boolean; runner?: string },
  source: Generation | undefined,
  fallback: Settings,
): Generation {
  const base = source ?? { ...fallback, prompt: "", model: "", jobId: "", createdAt: "" };
  const keep = {
    prompt: base.prompt,
    negative_prompt: base.negative_prompt,
    width: base.width,
    height: base.height,
    steps: base.steps,
    guidance: base.guidance,
    seed: base.seed,
  };
  return {
    ...keep,
    kind: "upscale",
    scale: job.scale,
    outputWidth: job.width,
    outputHeight: job.height,
    model: job.model,
    jobId: job.jobId,
    createdAt: job.createdAt,
    ...(job.runner ? { runner: job.runner } : {}),
    ...(job.demo ? { demo: true } : {}),
  };
}
export interface Layer {
  id: string;
  kind: Kind;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
  locked: boolean;
  groupId: string | null;
  opacity?: number;
  blendMode?: (typeof blendModes)[number];
  noteColor?: "sage" | "sand" | "rose" | "sky";
  assetId?: string;
  originalAssetId?: string;
  /** Alpha mask asset plus live, nondestructive refinements (feather in mask pixels, density 0–1). */
  layerMask?: {
    assetId: string;
    enabled: boolean;
    feather?: number;
    density?: number;
  };
  /** Nondestructive colour adjustments for image layers; pixels stay untouched. */
  adjustments?: Adjustments;
  rotation?: number;
  flipX?: boolean;
  flipY?: boolean;
  textStyle?: TextStyle;
  /** Draw this image with hard pixel edges (pixel art) on the canvas and in exports. */
  pixelated?: boolean;
  /** Video layers reference project.videos. */
  videoId?: string;
  text?: string;
  metadata?: Generation;
  mask?: {
    targetLayerId: string;
    strokes: { points: number[][]; radius: number; erase: boolean }[];
  };
}
export interface Group {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
}
export interface Asset {
  id: string;
  data: string;
  width: number;
  height: number;
}
export interface VideoMetadata {
  prompt: string;
  negative_prompt: string;
  width: number;
  height: number;
  frames: number;
  fps: number;
  steps: number;
  guidance: number;
  seed: number;
  model: string;
  jobId: string;
  createdAt: string;
  start_image?: boolean;
  demo?: boolean;
}
export interface VideoAsset {
  id: string;
  /** Embedded MP4 or WebM. */
  data: string;
  width: number;
  height: number;
  duration: number;
  fps: number;
  metadata?: VideoMetadata;
}
import type { PoseSpec } from "./pose.ts";
import { cleanPose } from "./pose.ts";
export interface Transcript {
  text: string;
  srt: string;
  language: string;
}
/** A sound in the project: generated speech or music, or a file the user added. Immutable once created. */
export interface AudioClip {
  id: string;
  name: string;
  kind: "speech" | "music" | "upload";
  /** Embedded MP3, WAV, M4A, OGG, WebM or FLAC. */
  data: string;
  duration: number;
  metadata?: {
    text?: string;
    style?: string;
    lyrics?: string;
    seed?: number;
    model?: string;
    jobId?: string;
    createdAt?: string;
    clonedVoice?: boolean;
    demo?: boolean;
  };
  transcript?: Transcript;
}
export const audioDataPattern =
  /^data:audio\/(mpeg|mp3|wav|x-wav|wave|mp4|x-m4a|aac|ogg|webm|flac|x-flac);base64,[A-Za-z0-9+/=]+$/;
export interface SpriteFrame {
  assetId: string;
  /** Per-frame hold in milliseconds; defaults to 1000 / fps. */
  duration?: number;
}
export interface Sprite {
  id: string;
  name: string;
  fps: number;
  loop: boolean;
  /** Frames share one cell size in the sheet: the largest frame, centred (pivot bottom-centre). */
  frames: SpriteFrame[];
  pixelated?: boolean;
}
export interface Project {
  format: "studio-zero";
  version: 2;
  id: string;
  title: string;
  layers: Layer[];
  groups: Group[];
  assets: Record<string, Asset>;
  references: string[];
  view: { x: number; y: number; zoom: number; grid: boolean };
  settings: Settings;
  gallery: { id: string; assetId: string; metadata: Generation }[];
  videos: Record<string, VideoAsset>;
  sprites: Sprite[];
  clips: AudioClip[];
  /** The pose that guides new images when enabled (Create → Pose). */
  pose?: { spec: PoseSpec; enabled: boolean };
}
export const defaults: Settings = {
  prompt: "",
  negative_prompt: "",
  width: 1024,
  height: 1024,
  steps: 28,
  guidance: 6,
  seed: -1,
};
export function blankProject(): Project {
  return {
    format: "studio-zero",
    version: 2,
    id: crypto.randomUUID(),
    title: "Untitled canvas",
    layers: [],
    groups: [],
    assets: {},
    references: [],
    view: { x: 0, y: 0, zoom: 1, grid: true },
    settings: { ...defaults },
    gallery: [],
    videos: {},
    sprites: [],
    clips: [],
  };
}
export function newLayer(kind: Kind, x: number, y: number): Layer {
  return {
    id: crypto.randomUUID(),
    kind,
    name:
      kind === "text"
        ? "Text"
        : kind === "note"
          ? "Untitled note"
          : kind === "prompt"
            ? "Generation idea"
            : kind === "video"
              ? "Video"
              : "Image",
    x,
    y,
    width: kind === "image" ? 512 : kind === "text" ? 480 : 260,
    height: kind === "image" ? 512 : kind === "text" ? 160 : 180,
    visible: true,
    locked: false,
    groupId: null,
    text:
      kind === "note"
        ? "A thought worth exploring…"
        : kind === "text"
          ? "Your words here"
          : "",
    ...(kind === "text" ? { textStyle: { ...defaultTextStyle } } : {}),
  };
}
export function visible(p: Project, l: Layer) {
  return (
    l.visible &&
    (!l.groupId || p.groups.find((g) => g.id === l.groupId)?.visible !== false)
  );
}
export function locked(p: Project, l: Layer) {
  return (
    l.locked ||
    (!!l.groupId && p.groups.find((g) => g.id === l.groupId)?.locked === true)
  );
}
export function bounds(layers: Layer[]) {
  if (!layers.length) return null;
  const boxes = layers.map(layerBounds);
  const x = Math.min(...boxes.map((l) => l.x)),
    y = Math.min(...boxes.map((l) => l.y));
  return {
    x,
    y,
    width: Math.max(...boxes.map((l) => l.x + l.width)) - x,
    height: Math.max(...boxes.map((l) => l.y + l.height)) - y,
  };
}
export function validateSettings(s: Settings) {
  if (!s.prompt.trim()) throw Error("Write an idea first.");
  for (const v of [s.width, s.height])
    if (!Number.isInteger(v) || v < 256 || v > 2048 || v % 32)
      throw Error("Dimensions must be multiples of 32, from 256 to 2048.");
  if (!Number.isInteger(s.steps) || s.steps < 1 || s.steps > 100)
    throw Error("Steps must be from 1 to 100.");
  if (!Number.isFinite(s.guidance) || s.guidance < 0 || s.guidance > 20)
    throw Error("Guidance must be from 0 to 20.");
  if (!Number.isInteger(s.seed) || s.seed < -1 || s.seed > 2147483647)
    throw Error("Seed must be -1 (random) or a number up to 2147483647.");
}
// Strictly reconstruct imported objects: no HTML, external image URLs, or executable content.
export function parseProject(raw: string): Project {
  const p = JSON.parse(raw);
  if (p.format !== "studio-zero" || p.version !== 2)
    throw Error("This is not a supported Studio Zero project (version 2).");
  const str = (v: unknown, max = 20000): string => {
    if (typeof v !== "string" || v.length > max)
      throw Error("Invalid project text.");
    return v;
  };
  const num = (v: unknown, min: number, max: number): number => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max)
      throw Error("Invalid project dimensions.");
    return v;
  };
  if (
    !Array.isArray(p.layers) ||
    p.layers.length > 2000 ||
    !Array.isArray(p.groups) ||
    !Array.isArray(p.gallery) ||
    p.gallery.length > 2000 ||
    !p.assets ||
    typeof p.assets !== "object"
  )
    throw Error("Invalid project structure.");
  const q = blankProject();
  q.id = str(p.id, 100);
  q.title = str(p.title, 200);
  q.assets = Object.create(null);
  for (const [id, a] of Object.entries(p.assets) as [string, any][]) {
    if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(a.data))
      throw Error("Project images must be embedded PNG, JPEG or WebP.");
    q.assets[id] = {
      id: str(id, 100),
      data: a.data,
      width: num(a.width, 1, 32768),
      height: num(a.height, 1, 32768),
    };
  }
  const ids = new Set<string>();
  const unique = (id: unknown) => {
    const s = str(id, 100);
    if (ids.has(s)) throw Error("Duplicate project ID.");
    ids.add(s);
    return s;
  };
  q.groups = p.groups.map((g: any) => ({
    id: unique(g.id),
    name: str(g.name, 200),
    visible: g.visible !== false,
    locked: g.locked === true,
  }));
  const settings = (s: any): Settings => {
    const out = {
      prompt: str(s.prompt),
      negative_prompt: str(s.negative_prompt),
      width: s.width,
      height: s.height,
      steps: s.steps,
      guidance: s.guidance,
      seed: s.seed,
      ...(s.transparent === true ? { transparent: true } : {}),
    };
    validateSettings({ ...out, prompt: out.prompt || "draft" });
    return out;
  };
  const videoMetadata = (m: any): VideoMetadata => ({
    prompt: str(m.prompt),
    negative_prompt: str(m.negative_prompt ?? ""),
    width: num(m.width, 1, 8192),
    height: num(m.height, 1, 8192),
    frames: num(m.frames, 1, 10000),
    fps: num(m.fps, 1, 240),
    steps: num(m.steps, 1, 100),
    guidance: num(m.guidance, 0, 20),
    seed: num(m.seed, -1, 2147483647),
    model: str(m.model, 300),
    jobId: str(m.jobId, 100),
    createdAt: str(m.createdAt, 100),
    ...(m.start_image === true ? { start_image: true } : {}),
    ...(m.demo === true ? { demo: true } : {}),
  });
  const metadata = (m: any): Generation => ({
    ...settings(m),
    model: str(m.model, 300),
    jobId: str(m.jobId, 100),
    createdAt: str(m.createdAt, 100),
    demo: m.demo === true,
    ...(m.reference_count !== undefined
      ? { reference_count: num(m.reference_count, 0, 3) }
      : {}),
    ...(["image", "edit", "upscale"].includes(m.kind) ? { kind: m.kind } : {}),
    ...(editOperations.includes(m.operation) ? { operation: m.operation } : {}),
    ...(m.strength !== undefined ? { strength: num(m.strength, 0, 1) } : {}),
    ...(m.runner ? { runner: str(m.runner, 300) } : {}),
    ...(m.scale !== undefined ? { scale: num(m.scale, 1, 8) } : {}),
    ...(m.outputWidth !== undefined ? { outputWidth: num(m.outputWidth, 1, 16384) } : {}),
    ...(m.outputHeight !== undefined ? { outputHeight: num(m.outputHeight, 1, 16384) } : {}),
    ...(m.runnerRevision ? { runnerRevision: str(m.runnerRevision, 100) } : {}),
  });
  q.videos = Object.create(null);
  if (p.videos !== undefined) {
    if (!p.videos || typeof p.videos !== "object" || Array.isArray(p.videos))
      throw Error("Invalid project videos.");
    for (const [id, v] of Object.entries(p.videos) as [string, any][]) {
      if (
        typeof v?.data !== "string" ||
        v.data.length > 400 * 1024 * 1024 ||
        !/^data:video\/(mp4|webm);base64,[A-Za-z0-9+/=]+$/.test(v.data)
      )
        throw Error("Project videos must be embedded MP4 or WebM.");
      q.videos[id] = {
        id: str(id, 100),
        data: v.data,
        width: num(v.width, 1, 8192),
        height: num(v.height, 1, 8192),
        duration: num(v.duration, 0, 3600),
        fps: num(v.fps, 1, 240),
        ...(v.metadata ? { metadata: videoMetadata(v.metadata) } : {}),
      };
    }
  }
  q.layers = p.layers.map((l: any) => {
    if (!["image", "text", "note", "prompt", "mask", "video"].includes(l.kind))
      throw Error("Unknown layer type.");
    if (l.kind === "video" && (!l.videoId || !q.videos[l.videoId] || l.assetId))
      throw Error("Video layer has no video.");
    if (l.assetId && !q.assets[l.assetId]) throw Error("Missing image asset.");
    if (l.originalAssetId && !q.assets[l.originalAssetId])
      throw Error("Missing original image asset.");
    if (l.kind === "image" && !l.assetId)
      throw Error("Image layer has no asset.");
    if (l.groupId && !q.groups.some((g) => g.id === l.groupId))
      throw Error("Missing group.");
    const out: Layer = {
      id: unique(l.id),
      kind: l.kind,
      rotation: l.rotation === undefined ? 0 : num(l.rotation, -360, 360),
      flipX: l.flipX === true,
      flipY: l.flipY === true,
      name: str(l.name, 200),
      x: num(l.x, -1e7, 1e7),
      y: num(l.y, -1e7, 1e7),
      width: num(l.width, 16, 32768),
      height: num(l.height, 16, 32768),
      visible: l.visible !== false,
      locked: l.locked === true,
      groupId: l.groupId || null,
      opacity: l.opacity === undefined ? 1 : num(l.opacity, 0, 1),
      blendMode: blendModes.includes(l.blendMode) ? l.blendMode : "normal",
      noteColor: ["sage", "sand", "rose", "sky"].includes(l.noteColor)
        ? l.noteColor
        : "sage",
      ...(l.assetId ? { assetId: l.assetId } : {}),
      ...(l.originalAssetId
        ? { originalAssetId: str(l.originalAssetId, 100) }
        : {}),
      ...(l.text !== undefined ? { text: str(l.text) } : {}),
      ...(l.kind === "video" ? { videoId: str(l.videoId, 100) } : {}),
      ...(l.pixelated === true && l.kind === "image" ? { pixelated: true } : {}),
      ...(l.metadata ? { metadata: metadata(l.metadata) } : {}),
    };
    if (l.layerMask !== undefined) {
      if (
        l.kind !== "image" ||
        !l.layerMask ||
        typeof l.layerMask.enabled !== "boolean"
      )
        throw Error("Invalid layer mask.");
      const maskId = str(l.layerMask.assetId, 100);
      if (!q.assets[maskId]) throw Error("Missing layer mask asset.");
      out.layerMask = { assetId: maskId, enabled: l.layerMask.enabled };
      if (l.layerMask.feather !== undefined)
        out.layerMask.feather = num(l.layerMask.feather, 0, 250);
      if (l.layerMask.density !== undefined)
        out.layerMask.density = num(l.layerMask.density, 0, 1);
    }
    if (l.adjustments !== undefined) {
      if (l.kind !== "image") throw Error("Invalid image adjustments.");
      out.adjustments = parseAdjustments(l.adjustments);
    }
    if (l.kind === "text") {
      if (l.assetId) throw Error("Text layers cannot contain image assets.");
      const style = { ...defaultTextStyle, ...l.textStyle };
      if (
        !["Arial", "Georgia", "Courier New"].includes(style.fontFamily) ||
        !["left", "center", "right"].includes(style.align) ||
        !/^#[0-9a-f]{6}$/i.test(style.color)
      )
        throw Error("Invalid text style.");
      out.textStyle = {
        fontFamily: style.fontFamily,
        fontSize: num(style.fontSize, 8, 512),
        color: style.color,
        bold: style.bold === true,
        italic: style.italic === true,
        align: style.align,
        lineHeight: num(style.lineHeight, 0.8, 3),
      };
    }
    if (l.mask) {
      if (!Array.isArray(l.mask.strokes) || l.mask.strokes.length > 10000)
        throw Error("Invalid mask.");
      out.mask = {
        targetLayerId: str(l.mask.targetLayerId, 100),
        strokes: l.mask.strokes.map((s: any) => {
          if (!Array.isArray(s.points) || s.points.length > 100000)
            throw Error("Invalid mask points.");
          return {
            radius: num(s.radius, 1, 2048),
            erase: s.erase === true,
            points: s.points.map((a: any) => [
              num(a[0], -1e7, 1e7),
              num(a[1], -1e7, 1e7),
            ]),
          };
        }),
      };
    }
    return out;
  });
  if (p.references !== undefined) {
    if (
      !Array.isArray(p.references) ||
      p.references.length > 3 ||
      new Set(p.references).size !== p.references.length
    )
      throw Error("Use up to three distinct reference images.");
    q.references = p.references.map((id: unknown) => {
      const key = str(id, 100);
      if (!q.assets[key]) throw Error("Missing reference image asset.");
      return key;
    });
  }
  if (p.sprites !== undefined) {
    if (!Array.isArray(p.sprites) || p.sprites.length > 500)
      throw Error("Invalid sprites.");
    q.sprites = p.sprites.map((sp: any) => {
      if (!Array.isArray(sp?.frames) || sp.frames.length > 1024)
        throw Error("Invalid sprite frames.");
      return {
        id: unique(sp.id),
        name: str(sp.name, 200),
        fps: num(sp.fps, 1, 60),
        loop: sp.loop !== false,
        ...(sp.pixelated === true ? { pixelated: true } : {}),
        frames: sp.frames.map((f: any) => {
          const assetId = str(f?.assetId, 100);
          if (!q.assets[assetId]) throw Error("Missing sprite frame image.");
          return {
            assetId,
            ...(f.duration !== undefined
              ? { duration: num(f.duration, 10, 10000) }
              : {}),
          };
        }),
      };
    });
  }
  q.clips = [];
  if (p.clips !== undefined) {
    if (!Array.isArray(p.clips) || p.clips.length > 500) throw Error("Invalid audio clips.");
    const seen = new Set<string>();
    q.clips = p.clips.map((c: any) => {
      if (typeof c?.data !== "string" || c.data.length > 200 * 1024 * 1024 || !audioDataPattern.test(c.data))
        throw Error("Project audio must be embedded MP3, WAV, M4A, OGG, WebM or FLAC.");
      const id = str(c.id, 100);
      if (!id || seen.has(id)) throw Error("Duplicate audio clip.");
      seen.add(id);
      const m = c.metadata;
      const t = c.transcript;
      return {
        id,
        name: str(c.name, 200),
        kind: ["speech", "music", "upload"].includes(c.kind) ? c.kind : "upload",
        data: c.data,
        duration: num(c.duration, 0, 36000),
        ...(m && typeof m === "object"
          ? {
              metadata: {
                ...(m.text !== undefined ? { text: str(m.text, 5000) } : {}),
                ...(m.style !== undefined ? { style: str(m.style, 2000) } : {}),
                ...(m.lyrics !== undefined ? { lyrics: str(m.lyrics, 3500) } : {}),
                ...(m.seed !== undefined ? { seed: num(m.seed, -1, 2147483647) } : {}),
                ...(m.model !== undefined ? { model: str(m.model, 300) } : {}),
                ...(m.jobId !== undefined ? { jobId: str(m.jobId, 100) } : {}),
                ...(m.createdAt !== undefined ? { createdAt: str(m.createdAt, 100) } : {}),
                ...(m.clonedVoice === true ? { clonedVoice: true } : {}),
                ...(m.demo === true ? { demo: true } : {}),
              },
            }
          : {}),
        ...(t && typeof t === "object"
          ? { transcript: { text: str(t.text, 200000), srt: str(t.srt, 400000), language: str(t.language, 10) } }
          : {}),
      } as AudioClip;
    });
  }
  if (p.pose !== undefined && p.pose !== null) {
    const spec = cleanPose(p.pose?.spec);
    if (spec) q.pose = { spec, enabled: p.pose.enabled === true };
  }
  q.settings = settings(p.settings);
  q.view = {
    x: num(p.view.x, -1e8, 1e8),
    y: num(p.view.y, -1e8, 1e8),
    zoom: num(p.view.zoom, 0.05, 8),
    grid: p.view.grid !== false,
  };
  q.gallery = p.gallery.map((g: any) => {
    if (!q.assets[g.assetId]) throw Error("Missing history asset.");
    return {
      id: str(g.id, 100),
      assetId: str(g.assetId, 100),
      metadata: metadata(g.metadata),
    };
  });
  return q;
}
/**
 * A history snapshot. Assets and videos are immutable once created (every edit adds a new id),
 * so snapshots share them and deep-copy only the small structural state. This keeps 40 undo
 * steps cheap even with large images and embedded videos.
 */
export function snapshot(p: Project): Project {
  const { assets, videos, clips, ...rest } = p;
  return {
    ...structuredClone(rest),
    assets: { ...assets },
    videos: { ...videos },
    clips: [...(clips ?? [])],
  };
}
export class History {
  private past: Project[] = [];
  private future: Project[] = [];
  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }
  push(p: Project) {
    this.past.push(snapshot(p));
    if (this.past.length > 40) this.past.shift();
    this.future = [];
  }
  undo(p: Project) {
    const next = this.past.pop();
    if (next) this.future.push(snapshot(p));
    return next;
  }
  redo(p: Project) {
    const next = this.future.pop();
    if (next) this.past.push(snapshot(p));
    return next;
  }
  clear() {
    this.past = [];
    this.future = [];
  }
}
