/**
 * The Audio tab: text to speech with voice cloning, music, transcription, and the project's clips.
 * Generation runs on the engine (Chatterbox Turbo, MiniMax Music 3, faster-whisper); clips are
 * embedded in the project like videos, so a saved .zero file keeps them.
 */
import type { AudioClip, Transcript } from "./model.ts";
import { audioDataPattern, newLayer } from "./model.ts";
import type { Job, StudioService, TranscriptResult } from "./service.ts";
import type { StudioContext } from "./studio-context.ts";
import { h, jobView } from "./studio-context.ts";
import { engineFor, followTask, improveButton } from "./assist.ts";
import { download, readData } from "./storage.ts";
import { blobToDataURL } from "./video.ts";
import { audioExtension, audioType, dataBytes, formatSeconds } from "./audio-util.ts";

const ENGINE_AUDIO_LIMIT = 32 * 1024 * 1024;
const LANGUAGES: [string, string][] = [
  ["", "Detect automatically"],
  ["en", "English"],
  ["he", "Hebrew"],
  ["ar", "Arabic"],
  ["es", "Spanish"],
  ["fr", "French"],
  ["de", "German"],
  ["ru", "Russian"],
  ["pt", "Portuguese"],
  ["it", "Italian"],
  ["ja", "Japanese"],
  ["zh", "Chinese"],
];

function dataToBlob(data: string) {
  const comma = data.indexOf(",");
  const type = data.slice(5, data.indexOf(";"));
  const bytes = atob(data.slice(comma + 1));
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes.charCodeAt(i);
  return new Blob([out], { type });
}

const urls = new Map<string, string>();
/** One object URL per clip (data URLs of whole songs are slow to hand to <audio>). */
function clipURL(clip: AudioClip) {
  let url = urls.get(clip.id);
  if (!url) {
    url = URL.createObjectURL(dataToBlob(clip.data));
    urls.set(clip.id, url);
  }
  return url;
}
function releaseURLs(keep: Set<string>) {
  for (const [id, url] of urls)
    if (!keep.has(id)) {
      URL.revokeObjectURL(url);
      urls.delete(id);
    }
}

function audioDuration(url: string, timeout = 15000): Promise<number> {
  return new Promise((resolve) => {
    const a = new Audio();
    const done = (value: number) => {
      clearTimeout(timer);
      a.removeAttribute("src");
      resolve(value);
    };
    const timer = setTimeout(() => done(0), timeout);
    a.preload = "metadata";
    a.onloadedmetadata = () => done(Number.isFinite(a.duration) ? a.duration : 0);
    a.onerror = () => done(0);
    a.src = url;
  });
}

export function installAudio(ctx: StudioContext) {
  const panel = document.getElementById("panel-audio")!;
  const has = (cap: string) => ctx.capabilities().includes(cap);

  // ── Voice ───────────────────────────────────────────────────────────────────
  const speechText = h("textarea", {
    id: "speech-text",
    rows: 4,
    maxlength: 5000,
    "aria-label": "Text to speak",
    placeholder: "Welcome to the shop. Everything you see was imagined this morning. [chuckle]",
  }) as HTMLTextAreaElement;
  const voiceSource = h("select", { id: "speech-voice", "aria-label": "Voice" }) as HTMLSelectElement;
  const voiceFile = h("input", { type: "file", accept: "audio/*,video/mp4,video/webm", hidden: true, id: "speech-voice-file" }) as HTMLInputElement;
  const speak = h("button", { type: "button", class: "generate", id: "speech-generate" }, h("span", { text: "◖" }), " Speak ", h("span", { text: "↗" }));
  const { element: speechJobEl, view: speechView } = jobView("speech");
  const speechNote = h("p", { class: "subtle", id: "speech-note" });
  panel.append(
    h("div", { class: "section-heading" }, h("span", { class: "eyebrow", text: "VOICE" }), h("span", { class: "accent", text: "◖" })),
    h("label", { class: "field-label", for: "speech-text", text: "What to say" }),
    speechText,
    h("label", { class: "resolution-label" }, "Voice", voiceSource),
    voiceFile,
    h("p", {
      class: "subtle",
      text: "English. Tags like [laugh] or [sigh] add expression. To clone a voice, pick or upload a clean 10-second sample — only voices you have permission to use.",
    }),
    speak,
    speechJobEl,
    speechNote,
  );

  // ── Music ───────────────────────────────────────────────────────────────────
  const musicStyle = h("textarea", {
    id: "music-style",
    rows: 3,
    maxlength: 2000,
    "aria-label": "Music style",
    placeholder: "Dreamy synth-pop, 104 BPM, warm female vocal, glassy pads building into a big chorus",
  }) as HTMLTextAreaElement;
  const styleImprove = improveButton(ctx, musicStyle, "music");
  const lyrics = h("textarea", {
    id: "music-lyrics",
    rows: 6,
    maxlength: 3500,
    "aria-label": "Lyrics",
    placeholder: "[verse]\nCity lights in the rear-view mirror\n[chorus]\nWe were young and the night was ours",
  }) as HTMLTextAreaElement;
  const instrumental = h("input", { type: "checkbox", id: "music-instrumental" }) as HTMLInputElement;
  const musicLength = h("select", { id: "music-length", "aria-label": "Song length" },
    ...[30, 60, 90, 120, 180, 240, 300].map((s) => h("option", { value: s, text: `up to ${formatSeconds(s)}`, selected: s === 60 }))) as HTMLSelectElement;
  const compose = h("button", { type: "button", class: "generate", id: "music-generate" }, h("span", { text: "♪" }), " Compose ", h("span", { text: "↗" }));
  const { element: musicJobEl, view: musicView } = jobView("music");
  const musicNote = h("p", { class: "subtle", id: "music-note" });
  instrumental.onchange = () => {
    lyrics.disabled = instrumental.checked;
  };
  panel.append(
    h("div", { class: "section-heading audio-heading" }, h("span", { class: "eyebrow", text: "MUSIC" }), h("span", { class: "accent", text: "♪" })),
    h("div", { class: "field-heading" }, h("label", { for: "music-style", text: "The sound" }), styleImprove.element),
    musicStyle,
    h("label", { class: "field-label", for: "music-lyrics", text: "Lyrics" }),
    lyrics,
    h("div", { class: "ai-row" }, h("label", {}, "Length", musicLength), h("label", { class: "check" }, instrumental, "Instrumental")),
    h("p", { class: "subtle", text: "Put [verse], [chorus], [bridge] on their own lines. Name the vocal (for example “warm female vocal”) or the song may drift instrumental." }),
    compose,
    musicJobEl,
    musicNote,
  );

  // ── Transcribe ──────────────────────────────────────────────────────────────
  const transcribeSource = h("select", { id: "transcribe-source", "aria-label": "Sound to transcribe" }) as HTMLSelectElement;
  const transcribeFile = h("input", { type: "file", accept: "audio/*,video/*", hidden: true, id: "transcribe-file" }) as HTMLInputElement;
  const language = h("select", { id: "transcribe-language", "aria-label": "Language" },
    ...LANGUAGES.map(([v, t]) => h("option", { value: v, text: t }))) as HTMLSelectElement;
  const transcribe = h("button", { type: "button", class: "primary full", id: "transcribe-run", text: "✎ Transcribe" });
  const transcribeStatus = h("p", { class: "subtle", id: "transcribe-status" });
  const transcriptBox = h("textarea", { id: "transcript", rows: 6, readonly: true, hidden: true, "aria-label": "Transcript" }) as HTMLTextAreaElement;
  const copyText = h("button", { type: "button", class: "quiet", text: "Copy text" });
  const saveSrt = h("button", { type: "button", class: "quiet", text: "Download .srt" });
  const addNote = h("button", { type: "button", class: "quiet", text: "Add as note" });
  const transcriptActions = h("div", { class: "selection-actions", hidden: true }, copyText, saveSrt, addNote);
  panel.append(
    h("div", { class: "section-heading audio-heading" }, h("span", { class: "eyebrow", text: "TRANSCRIBE" }), h("span", { class: "accent", text: "✎" })),
    h("p", { class: "subtle", text: "Speech to text with timed subtitles, from a clip, a video layer or a file." }),
    h("label", { class: "resolution-label" }, "Sound", transcribeSource),
    transcribeFile,
    h("label", { class: "resolution-label" }, "Language", language),
    transcribe,
    transcribeStatus,
    transcriptBox,
    transcriptActions,
  );

  // ── Clips ───────────────────────────────────────────────────────────────────
  const addClip = h("button", { type: "button", class: "quiet", id: "audio-add", text: "+ Add a sound file" });
  const addFile = h("input", { type: "file", accept: "audio/*", hidden: true, id: "audio-add-file" }) as HTMLInputElement;
  const list = h("div", { id: "audio-list" });
  panel.append(
    h("div", { class: "section-heading audio-heading" }, h("span", { class: "eyebrow", text: "YOUR SOUNDS" }), h("span", { class: "accent", text: "≋" })),
    h("div", { class: "selection-actions" }, addClip),
    addFile,
    list,
  );

  const clips = () => ctx.project().clips;
  const live = (id: string) => clips().find((c) => c.id === id);

  function addToProject(clip: AudioClip) {
    const project = ctx.project();
    ctx.commit(() => {
      project.clips.push(clip);
    });
    render(true);
    return clip;
  }

  async function clipFromFile(file: File, kind: AudioClip["kind"] = "upload") {
    const data = await readData(file);
    const fixed = data.replace(/^data:[^,]*,/, `data:${audioType(file)};base64,`);
    if (!audioDataPattern.test(fixed)) throw Error("Use an MP3, WAV, M4A, OGG, WebM or FLAC file.");
    const blobUrl = URL.createObjectURL(file);
    const duration = await audioDuration(blobUrl).finally(() => URL.revokeObjectURL(blobUrl));
    return addToProject({
      id: crypto.randomUUID(),
      name: file.name.replace(/\.[^.]+$/, "").slice(0, 200) || "Sound",
      kind,
      data: fixed,
      duration,
    });
  }

  /** Download a finished speech or music job and keep it as a clip. */
  async function placeAudio(job: Job, engine: StudioService) {
    const existing = clips().find((c) => c.metadata?.jobId === job.id);
    if (existing) {
      ctx.showTab("audio");
      return ctx.toast("This sound is already in your project.");
    }
    const projectId = ctx.project().id;
    const blob = await engine.output(job.output_id!);
    let data = await blobToDataURL(blob);
    if (data.startsWith("data:application/octet-stream"))
      data = data.replace("data:application/octet-stream", job.metadata.format === "mp3" ? "data:audio/mpeg" : "data:audio/wav");
    const url = URL.createObjectURL(blob);
    const duration = await audioDuration(url).finally(() => URL.revokeObjectURL(url));
    if (ctx.project().id !== projectId) throw Error("The project changed before the sound arrived.");
    const m = job.metadata;
    const kind = m.kind === "music" ? "music" : "speech";
    const words = (kind === "music" ? m.style : m.text) ?? "";
    addToProject({
      id: crypto.randomUUID(),
      name: (kind === "music" ? "Song · " : "Voice · ") + words.slice(0, 50),
      kind,
      data,
      duration: duration || m.duration || 0,
      metadata: {
        ...(m.text ? { text: m.text } : {}),
        ...(m.style ? { style: m.style } : {}),
        ...(m.lyrics ? { lyrics: m.lyrics } : {}),
        seed: m.seed,
        model: m.model,
        jobId: m.jobId,
        createdAt: m.createdAt,
        ...(m.cloned_voice ? { clonedVoice: true } : {}),
        ...(m.demo ? { demo: true } : {}),
      },
    });
    ctx.showTab("audio");
    ctx.toast(m.demo ? "Demo sound added (synthesized, not AI)." : kind === "music" ? "Your song is ready below." : "Your voice clip is ready below.");
  }

  // Voice actions
  voiceSource.onchange = () => {
    if (voiceSource.value === "upload") voiceFile.click();
  };
  voiceFile.onchange = async () => {
    const file = voiceFile.files?.[0];
    voiceFile.value = "";
    if (!file) return void (voiceSource.value = "");
    try {
      const clip = await clipFromFile(file);
      if (clip.duration && clip.duration <= 5) ctx.toast("This sample is under 5 seconds; voice cloning needs a longer one (about 10 s).");
      voiceSource.value = clip.id;
    } catch (e) {
      voiceSource.value = "";
      ctx.fail(e);
    }
  };
  speak.onclick = async () => {
    const text = speechText.value.trim();
    if (!text) return ctx.toast("Write what the voice should say.");
    if (!engineFor(ctx, "speech", "ENABLE_VOICE")) return;
    const sample = voiceSource.value && voiceSource.value !== "upload" ? live(voiceSource.value) : undefined;
    if (sample) {
      if (sample.duration && sample.duration <= 5) return ctx.toast("Voice cloning needs a sample longer than 5 seconds.");
      if (dataBytes(sample.data) > ENGINE_AUDIO_LIMIT) return ctx.toast("This sample is over 32 MB. Use a shorter clip.");
    }
    try {
      await ctx.runJob((engine) => engine.speech({ text, ...(sample ? { voice: sample.data } : {}) }), speechView, placeAudio);
    } finally {
      sync();
    }
  };

  // Music actions
  compose.onclick = async () => {
    const style = musicStyle.value.trim();
    if (!style) return ctx.toast("Describe the sound of the song.");
    if (!instrumental.checked && !lyrics.value.trim()) return ctx.toast("Add lyrics, or tick Instrumental.");
    if (!engineFor(ctx, "music", "ENABLE_MUSIC")) return;
    try {
      await ctx.runJob(
        (engine) => engine.music({ style, lyrics: instrumental.checked ? "" : lyrics.value, duration: +musicLength.value, instrumental: instrumental.checked }),
        musicView,
        placeAudio,
      );
    } finally {
      sync();
    }
  };

  // Transcribe actions
  let lastTranscript: (Transcript & { name: string }) | null = null;
  transcribeSource.onchange = () => {
    if (transcribeSource.value === "upload") transcribeFile.click();
  };
  transcribeFile.onchange = async () => {
    const file = transcribeFile.files?.[0];
    transcribeFile.value = "";
    if (!file) return void (transcribeSource.value = "");
    try {
      if (file.size > ENGINE_AUDIO_LIMIT) throw Error("This file is over 32 MB. Use a shorter clip or extract the sound first.");
      if (file.type.startsWith("video/")) {
        // Videos are sent as they are; the engine reads their sound track.
        pendingVideo = { name: file.name, data: await readData(file) };
        renderSources("file");
      } else {
        const clip = await clipFromFile(file);
        transcribeSource.value = clip.id;
      }
    } catch (e) {
      transcribeSource.value = "";
      ctx.fail(e);
    }
  };
  let pendingVideo: { name: string; data: string } | null = null;

  function sourceData(): { name: string; data: string; clipId?: string } | undefined {
    const value = transcribeSource.value;
    if (value === "file" && pendingVideo) return pendingVideo;
    if (value.startsWith("video:")) {
      const video = ctx.project().videos[value.slice(6)];
      return video ? { name: "Video", data: video.data } : undefined;
    }
    const clip = live(value);
    return clip ? { name: clip.name, data: clip.data, clipId: clip.id } : undefined;
  }

  async function runTranscription(source: { name: string; data: string; clipId?: string }) {
    const engine = engineFor(ctx, "transcribe", "ENABLE_TRANSCRIBE");
    if (!engine) return;
    if (dataBytes(source.data) > ENGINE_AUDIO_LIMIT) return ctx.toast("This sound is over 32 MB. Use a shorter clip.");
    transcribeStatus.textContent = "Sending the sound…";
    try {
      const result = await ctx.exclusive(async () =>
        followTask<TranscriptResult>(engine, await engine.transcribe(source.data, language.value || undefined), {
          onProgress: (t) => {
            transcribeStatus.textContent = t.message + (t.progress ? ` ${t.progress}%` : "");
          },
        }),
      );
      if (!result) return void (transcribeStatus.textContent = "");
      const transcript = { text: result.text, srt: result.srt, language: result.language };
      lastTranscript = { ...transcript, name: source.name };
      transcriptBox.value = result.text || "(No speech found.)";
      transcriptBox.hidden = false;
      transcriptActions.hidden = false;
      transcribeStatus.textContent = `${formatSeconds(result.duration)} · ${result.language} · ${result.segments.length} subtitle lines${/demo/i.test(result.model) ? " · DEMO, NOT AI" : ""}`;
      const clip = source.clipId ? live(source.clipId) : undefined;
      if (clip) {
        const project = ctx.project();
        ctx.commit(() => {
          const i = project.clips.findIndex((c) => c.id === clip.id);
          if (i >= 0) project.clips[i] = { ...project.clips[i], transcript };
        });
        render(true);
      }
    } catch (e) {
      transcribeStatus.textContent = (e as Error).message;
      ctx.fail(e);
    }
  }
  transcribe.onclick = () => {
    const source = sourceData();
    if (!source) return ctx.toast("Pick a sound, a video layer or a file to transcribe.");
    void runTranscription(source);
  };
  copyText.onclick = async () => {
    if (!lastTranscript) return;
    try {
      await navigator.clipboard.writeText(lastTranscript.text);
      ctx.toast("Transcript copied.");
    } catch {
      transcriptBox.select();
      ctx.toast("Select-all is ready: press Ctrl+C to copy.");
    }
  };
  saveSrt.onclick = () => {
    if (lastTranscript) download(`${lastTranscript.name.replace(/[^\w .-]+/g, "_").slice(0, 60) || "transcript"}.srt`, new Blob([lastTranscript.srt], { type: "text/plain" }));
  };
  addNote.onclick = () => {
    if (!lastTranscript) return;
    const c = ctx.center();
    const layer = newLayer("note", c.x - 160, c.y - 120);
    layer.text = lastTranscript.text.slice(0, 20000);
    layer.name = `Transcript · ${lastTranscript.name}`.slice(0, 200);
    const project = ctx.project();
    ctx.commit(() => {
      project.layers.push(layer);
    });
    ctx.select([layer.id]);
    ctx.toast("Transcript added to the canvas as a note.");
  };

  // Clip list
  addClip.onclick = () => addFile.click();
  addFile.onchange = async () => {
    const file = addFile.files?.[0];
    addFile.value = "";
    if (!file) return;
    try {
      await clipFromFile(file);
      ctx.toast("Sound added to your project.");
    } catch (e) {
      ctx.fail(e);
    }
  };

  function renderSources(select?: string) {
    const project = ctx.project();
    const keepVoice = voiceSource.value,
      keepSource = select ?? transcribeSource.value;
    const sampleOptions = project.clips.map((c) => h("option", { value: c.id, text: `Clone: ${c.name}${c.duration ? ` (${formatSeconds(c.duration)})` : ""}` }));
    voiceSource.replaceChildren(h("option", { value: "", text: "Built-in voice" }), ...sampleOptions, h("option", { value: "upload", text: "Upload a voice sample…" }));
    voiceSource.value = [...voiceSource.options].some((o) => o.value === keepVoice) ? keepVoice : "";
    const videoOptions = Object.values(project.videos)
      .filter((v) => project.layers.some((l) => l.videoId === v.id))
      .map((v) => h("option", { value: `video:${v.id}`, text: `Video: ${project.layers.find((l) => l.videoId === v.id)?.name.slice(0, 50) ?? "video"}` }));
    transcribeSource.replaceChildren(
      h("option", { value: "", text: project.clips.length || videoOptions.length ? "Choose a sound…" : "Add a sound or video first…" }),
      ...project.clips.map((c) => h("option", { value: c.id, text: c.name })),
      ...videoOptions,
      ...(pendingVideo ? [h("option", { value: "file", text: `File: ${pendingVideo.name}` })] : []),
      h("option", { value: "upload", text: "Upload a file…" }),
    );
    transcribeSource.value = [...transcribeSource.options].some((o) => o.value === keepSource) ? keepSource : "";
  }

  function clipCard(clip: AudioClip) {
    const player = h("audio", { controls: true, preload: "none", src: clipURL(clip) });
    const meta = [
      { speech: "VOICE", music: "SONG", upload: "FILE" }[clip.kind],
      clip.duration ? formatSeconds(clip.duration) : "",
      clip.metadata?.demo ? "DEMO · NOT AI" : "",
      clip.metadata?.clonedVoice ? "cloned voice" : "",
    ].filter(Boolean).join(" · ");
    const useVoice = h("button", { type: "button", class: "quiet", text: "Use as voice" });
    const toText = h("button", { type: "button", class: "quiet", text: "Transcribe" });
    const save = h("button", { type: "button", class: "quiet", text: "Download" });
    const remove = h("button", { type: "button", class: "quiet danger", text: "Delete" });
    useVoice.onclick = () => {
      voiceSource.value = clip.id;
      speechText.focus();
      ctx.toast("This sound will be the voice for your next clip.");
    };
    toText.onclick = () => {
      transcribeSource.value = clip.id;
      void runTranscription({ name: clip.name, data: clip.data, clipId: clip.id });
    };
    save.onclick = () => download(`${clip.name.replace(/[^\w .-]+/g, "_").slice(0, 60) || "sound"}.${audioExtension(clip.data)}`, dataToBlob(clip.data));
    remove.onclick = () => {
      const project = ctx.project();
      ctx.commit(() => {
        project.clips = project.clips.filter((c) => c.id !== clip.id);
      });
      render(true);
    };
    const clip160 = (t: string) => (t.length > 160 ? t.slice(0, 159) + "…" : t);
    const words = clip.metadata?.text ?? clip.metadata?.style;
    const details = words ? clip160(words) : clip.transcript?.text ? `“${clip160(clip.transcript.text)}”` : "";
    return h(
      "div",
      { class: "edit-card audio-card", "data-clip": clip.id },
      h("strong", { text: clip.name }),
      h("small", { text: meta }),
      ...(details ? [h("p", { class: "subtle", text: details })] : []),
      player,
      h("div", { class: "selection-actions" }, useVoice, toText, save, remove),
    );
  }

  /** Re-render now when visible (or forced); otherwise when the tab is next shown. */
  function render(force = false) {
    if (panel.hidden && !force) return;
    const project = ctx.project();
    renderSources();
    const old = [...list.querySelectorAll("audio")];
    list.replaceChildren(
      ...(project.clips.length
        ? [...project.clips].reverse().map(clipCard)
        : [h("p", { class: "subtle", text: "Voices, songs and sound files you make or add appear here and are saved with your project." })]),
    );
    // Detach the old players before their URLs are released, so nothing loads a revoked URL.
    for (const a of old) {
      a.pause();
      a.removeAttribute("src");
    }
    releaseURLs(new Set(project.clips.map((c) => c.id)));
    sync();
  }

  function sync() {
    const busy = ctx.busy();
    const connected = !!ctx.service();
    speak.disabled = busy;
    compose.disabled = busy;
    transcribe.disabled = busy;
    styleImprove.sync();
    const missing = (cap: string, setting: string) =>
      connected && !has(cap) ? `Not on this engine yet: turn on ${setting} in the notebook and reconnect.` : "";
    speechNote.textContent = missing("speech", "ENABLE_VOICE");
    musicNote.textContent =
      missing("music", "ENABLE_MUSIC") || (connected ? "MiniMax-Music3 · show its name in commercial products and disclose AI music when you publish." : "");
    if (connected && !has("transcribe") && !transcribeStatus.textContent) transcribeStatus.textContent = missing("transcribe", "ENABLE_TRANSCRIBE");
    styleImprove.element.hidden = connected && !has("enhance-prompt");
  }

  render(true);
  return {
    render,
    sync,
    placeAudio,
    /** The project was replaced (open, new, undo): drop cached players. */
    reset() {
      lastTranscript = null;
      pendingVideo = null;
      transcriptBox.hidden = true;
      transcriptActions.hidden = true;
      transcribeStatus.textContent = "";
      render(true);
    },
  };
}
