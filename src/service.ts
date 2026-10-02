import type { Settings, Generation } from "./model.ts";
export interface Job {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  progress: number | null;
  message: string;
  output_id?: string;
  metadata: Generation & {
    frames?: number;
    fps?: number;
    start_image?: boolean;
    /** Speech and music jobs. */
    text?: string;
    style?: string;
    lyrics?: string;
    duration?: number;
    instrumental?: boolean;
    cloned_voice?: boolean;
    format?: string;
    scale?: number;
    source_width?: number;
    source_height?: number;
  };
}
export interface Health {
  ready: boolean;
  video_engine?: string;
  video_model?: string;
  engine_swap?: boolean;
  mode: "qwen" | "demo";
  message: string;
  capabilities: string[];
  /** Background removal state when the engine offers it: loading | ready | failed | stopped. */
  matting?: string;
  matting_mode?: "birefnet" | "demo";
  helper_models?: Record<string, string>;
}
/** Short-lived engine task (not generation history). */
export interface Task<R = unknown> {
  id: string;
  kind: "remove-background" | "transcribe" | "describe" | "enhance-prompt" | "detect-pose";
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  message: string;
  progress?: number | null;
  width?: number;
  height?: number;
  model: string;
  demo: boolean;
  /** Present when a text task succeeded. */
  result?: R;
}
export interface PromptResult {
  prompt: string;
  model: string;
}
export interface TranscriptResult {
  text: string;
  language: string;
  duration: number;
  segments: { start: number; end: number; text: string }[];
  srt: string;
  model: string;
  device: string;
}
export interface PoseResult {
  width: number;
  height: number;
  people: [number, number, number][][];
  model: string;
  device: string;
}
export type PromptTarget = "image" | "edit" | "video" | "music";
export interface SpeechRequest {
  text: string;
  /** A reference clip over 5 seconds whose voice is cloned. */
  voice?: string;
  temperature?: number;
  seed?: number;
}
export interface MusicRequest {
  style: string;
  lyrics: string;
  duration: number;
  instrumental: boolean;
  seed?: number;
}
/** An edit of one image; the source (and mask) are already sized to width × height. */
export interface EditRequest extends Settings {
  operation: "edit" | "inpaint" | "outpaint" | "image-to-image" | "variations";
  image: string;
  /** White = regenerate, black = keep (inpaint/outpaint). */
  mask?: string;
  strength?: number;
  reference_images?: string[];
}
export interface VideoRequest {
  prompt: string;
  negative_prompt?: string;
  width: number;
  height: number;
  frames: number;
  fps: number;
  steps: number;
  guidance: number;
  seed: number;
  image?: string;
  end_image?: string;
}
export class StudioService {
  public base: string;
  private token: string;
  constructor(base: string, token: string) {
    const u = new URL(base);
    if (u.search || u.hash || u.username || u.password)
      throw Error(
        "Use a service address without query parameters or embedded credentials.",
      );
    if (
      u.protocol !== "https:" &&
      !(
        u.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)
      )
    )
      throw Error("Use HTTPS for a remote service.");
    this.base = u.href.replace(/\/$/, "");
    this.token = token;
  }
  private async request(
    path: string,
    body?: unknown,
    binary = false,
    timeout = 30000,
  ) {
    let r: Response;
    try {
      r = await fetch(`${this.base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
        redirect: "error",
        credentials: "omit",
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw Error(
          "The engine took too long to respond. Check that the API and its tunnel are still running, then try again.",
        );
      }
      if (error instanceof TypeError) {
        const origin = globalThis.location?.origin;
        throw Error(
          "Could not reach the engine. Check that the API and its tunnel are still running and the service address is current. " +
            (origin
              ? `The API must allow this studio address: ${origin}. `
              : "The API must allow this studio's browser address. ") +
            "For the default local setup, open http://127.0.0.1:5173. If you use another address, add it to ZERO_ALLOWED_ORIGINS and restart the API.",
        );
      }
      throw error;
    }
    if (!r.ok) {
      let message = `Service returned ${r.status}.`;
      try {
        const e = await r.json();
        message = typeof e.detail === "string" ? e.detail : message;
      } catch {
        /* keep HTTP error */
      }
      throw Error(message);
    }
    return binary ? r.blob() : r.json();
  }
  health(): Promise<Health> {
    return this.request("/health");
  }
  generate(settings: Settings, referenceImages: string[] = []): Promise<Job> {
    return this.request("/generate", {
      ...settings,
      ...(referenceImages.length ? { reference_images: referenceImages } : {}),
    });
  }
  job(id: string): Promise<Job> {
    return this.request(`/jobs/${encodeURIComponent(id)}`);
  }
  jobs(): Promise<Job[]> {
    return this.request("/jobs");
  }
  cancel(id: string): Promise<Job> {
    return this.request(`/jobs/${encodeURIComponent(id)}/cancel`, {});
  }
  output(id: string): Promise<Blob> {
    return this.request(`/outputs/${encodeURIComponent(id)}`, undefined, true);
  }
  /** Uploads can be several MB over a tunnel, so allow longer than ordinary calls. */
  removeBackground(image: string): Promise<Task> {
    return this.request("/remove-background", { image }, false, 180000);
  }
  task<R = unknown>(id: string): Promise<Task<R>> {
    return this.request(`/tasks/${encodeURIComponent(id)}`);
  }
  cancelTask(id: string): Promise<Task> {
    return this.request(`/tasks/${encodeURIComponent(id)}/cancel`, {});
  }
  taskMask(id: string): Promise<Blob> {
    return this.request(
      `/tasks/${encodeURIComponent(id)}/mask`,
      undefined,
      true,
      120000,
    );
  }
  /** Edits upload images, so allow longer than ordinary calls. */
  edit(request: EditRequest): Promise<Job> {
    return this.request("/edit", request, false, 180000);
  }
  video(request: VideoRequest): Promise<Job> {
    return this.request("/video", request, false, 180000);
  }
  speech(request: SpeechRequest): Promise<Job> {
    return this.request("/speech", request, false, 180000);
  }
  music(request: MusicRequest): Promise<Job> {
    return this.request("/music", request);
  }
  transcribe(audio: string, language?: string): Promise<Task<TranscriptResult>> {
    return this.request("/transcribe", { audio, ...(language ? { language } : {}) }, false, 180000);
  }
  describe(image: string, purpose: "image" | "video" | "caption" = "image"): Promise<Task<PromptResult>> {
    return this.request("/describe", { image, purpose }, false, 180000);
  }
  upscale(image: string, scale: 2 | 4): Promise<Job> {
    return this.request("/upscale", { image, scale }, false, 180000);
  }
  detectPose(image: string): Promise<Task<PoseResult>> {
    return this.request("/detect-pose", { image }, false, 180000);
  }
  enhancePrompt(prompt: string, target: PromptTarget): Promise<Task<PromptResult>> {
    return this.request("/enhance-prompt", { prompt, target });
  }
}
