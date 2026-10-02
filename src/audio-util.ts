/** Pure helpers for audio clips (no DOM), shared by the Audio tab and tests. */

/** Bytes of a base64 data URL without decoding it. */
export function dataBytes(data: string) {
  const comma = data.indexOf(",");
  const body = data.length - comma - 1;
  return Math.floor((body * 3) / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
}

export function formatSeconds(s: number) {
  const total = Math.max(0, Math.round(s));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** File extension for an audio data URL. */
export function audioExtension(data: string) {
  const type = data.slice(5, data.indexOf(";")).split("/")[1] ?? "wav";
  return ({ mpeg: "mp3", mp3: "mp3", "x-wav": "wav", wave: "wav", "x-m4a": "m4a", mp4: "m4a", "x-flac": "flac" } as Record<string, string>)[type] ?? type;
}

/** The audio media type of a file, from its type or (when the browser gives none) its extension. */
export function audioType(file: { name: string; type: string }) {
  const type = file.type.toLowerCase().split(";")[0];
  if (type.startsWith("audio/")) return type;
  if (type === "video/mp4" || type === "video/quicktime") return "audio/mp4";
  if (type === "video/webm") return "audio/webm";
  const ext = file.name.toLowerCase().split(".").pop() ?? "";
  return ({ mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", mp4: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", webm: "audio/webm", flac: "audio/flac" } as Record<string, string>)[ext] ?? "application/octet-stream";
}
