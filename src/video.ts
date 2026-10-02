/** Video assets in the browser: playback URLs, metadata and frame extraction. */

/** Evenly spaced sample times (seconds) between start and end, centred in each slot. */
export function frameTimes(duration: number, count: number, start = 0, end = duration) {
  const a = Math.max(0, Math.min(start, duration)),
    b = Math.max(a, Math.min(end, duration));
  const n = Math.max(1, Math.round(count));
  const slot = (b - a) / n;
  return Array.from({ length: n }, (_, i) => Math.min(duration - 1e-3, a + slot * (i + 0.5)));
}

const urls = new Map<string, { url: string; id: string }>();
const keyOf = (id: string, data: string) => `${id}:${data.length}:${data.slice(-48)}`;

/** A blob: URL for an embedded video (data URLs are slow to seek); cached per video content. */
export function videoURL(id: string, data: string) {
  const key = keyOf(id, data);
  const cached = urls.get(key);
  if (cached) return cached.url;
  const [header, base64] = data.split(",", 2);
  const type = header.slice(5).split(";")[0];
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  urls.set(key, { url, id });
  return url;
}

/** Release cached video URLs that no longer belong to `videos` (deleted, or another project). */
export function releaseVideoURLs(videos: Record<string, { id: string; data: string }>) {
  for (const [key, entry] of urls) {
    const v = videos[entry.id];
    if (!v || keyOf(v.id, v.data) !== key) {
      URL.revokeObjectURL(entry.url);
      urls.delete(key);
    }
  }
}

export async function loadVideo(src: string, timeout = 20000) {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = src;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("This video did not load in time.")), timeout);
    video.onloadeddata = () => {
      clearTimeout(timer);
      resolve();
    };
    video.onerror = () => {
      clearTimeout(timer);
      reject(Error("This video cannot be played in this browser."));
    };
  });
  return video;
}

export function seek(video: HTMLVideoElement, time: number) {
  return new Promise<void>((resolve, reject) => {
    const done = () => {
      video.removeEventListener("seeked", done);
      resolve();
    };
    video.addEventListener("seeked", done);
    video.onerror = () => reject(Error("Could not read a video frame."));
    video.currentTime = Math.max(0, Math.min(time, video.duration || time));
  });
}

export function drawFrame(video: HTMLVideoElement, maxEdge = 4096) {
  const scale = Math.min(1, maxEdge / Math.max(video.videoWidth, video.videoHeight));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(video.videoWidth * scale));
  c.height = Math.max(1, Math.round(video.videoHeight * scale));
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(video, 0, 0, c.width, c.height);
  return c;
}

/** Sample frames as canvases (sequential seeks; works for MP4 and WebM). */
export async function extractFrames(
  src: string,
  options: { count: number; start?: number; end?: number; maxEdge?: number },
  onProgress?: (done: number, total: number) => void,
) {
  const video = await loadVideo(src);
  const times = frameTimes(video.duration, options.count, options.start, options.end);
  const frames: HTMLCanvasElement[] = [];
  for (const [i, t] of times.entries()) {
    await seek(video, t);
    frames.push(drawFrame(video, options.maxEdge));
    onProgress?.(i + 1, times.length);
  }
  video.removeAttribute("src");
  video.load();
  return frames;
}

/** Width, height and duration of a video blob or URL. */
export async function videoInfo(src: string) {
  const video = await loadVideo(src);
  const info = { width: video.videoWidth, height: video.videoHeight, duration: video.duration };
  video.removeAttribute("src");
  video.load();
  return info;
}

export function blobToDataURL(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
