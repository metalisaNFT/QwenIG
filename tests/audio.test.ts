import { test } from "node:test";
import assert from "node:assert/strict";
import { audioExtension, audioType, dataBytes, formatSeconds } from "../src/audio-util.ts";
import { blankProject, History, parseProject, snapshot } from "../src/model.ts";

const wav = "data:audio/wav;base64,UklGRiQAAABXQVZF";

test("audio helpers", () => {
  assert.equal(dataBytes("data:audio/wav;base64,AAAA"), 3);
  assert.equal(dataBytes("data:audio/wav;base64,AAA="), 2);
  assert.equal(formatSeconds(0), "0:00");
  assert.equal(formatSeconds(125.4), "2:05");
  assert.equal(audioExtension("data:audio/mpeg;base64,AA"), "mp3");
  assert.equal(audioExtension("data:audio/x-m4a;base64,AA"), "m4a");
  assert.equal(audioExtension("data:audio/ogg;base64,AA"), "ogg");
  assert.equal(audioType({ name: "a.MP3", type: "" }), "audio/mpeg");
  assert.equal(audioType({ name: "clip.mov", type: "video/quicktime" }), "audio/mp4");
  assert.equal(audioType({ name: "x", type: "audio/webm;codecs=opus" }), "audio/webm");
  assert.equal(audioType({ name: "notes.txt", type: "text/plain" }), "application/octet-stream");
});

test("audio clips round-trip through the project format", () => {
  const p = blankProject();
  p.clips.push({
    id: "c1",
    name: "Voice · hello",
    kind: "speech",
    data: wav,
    duration: 2.5,
    metadata: { text: "hello", seed: 3, model: "chatterbox", jobId: "j", createdAt: "now", clonedVoice: true },
    transcript: { text: "hello", srt: "1\n00:00:00,000 --> 00:00:01,000\nhello\n", language: "en" },
  });
  const q = parseProject(JSON.stringify(p));
  assert.deepEqual(q.clips, p.clips);
});

test("projects without clips (older files) load with an empty list", () => {
  const p = blankProject() as any;
  delete p.clips;
  assert.deepEqual(parseProject(JSON.stringify(p)).clips, []);
});

test("invalid clips are rejected", () => {
  for (const bad of [
    { id: "a", name: "x", kind: "upload", data: "data:text/plain;base64,AAAA", duration: 1 },
    { id: "a", name: "x", kind: "upload", data: "data:audio/wav;base64,<script>", duration: 1 },
  ]) {
    const p = blankProject() as any;
    p.clips = [bad];
    assert.throws(() => parseProject(JSON.stringify(p)), /audio/);
  }
  const p = blankProject() as any;
  p.clips = [
    { id: "a", name: "x", kind: "upload", data: wav, duration: 1 },
    { id: "a", name: "y", kind: "upload", data: wav, duration: 1 },
  ];
  assert.throws(() => parseProject(JSON.stringify(p)), /Duplicate/);
});

test("unknown clip kinds become uploads and junk metadata is dropped", () => {
  const p = blankProject() as any;
  p.clips = [{ id: "a", name: "x", kind: "ringtone", data: wav, duration: 1, metadata: { text: "t", evil: "<b>" } }];
  const q = parseProject(JSON.stringify(p));
  assert.equal(q.clips[0].kind, "upload");
  assert.deepEqual(q.clips[0].metadata, { text: "t" });
});

test("history snapshots share clip data instead of copying it", () => {
  const p = blankProject();
  p.clips.push({ id: "c", name: "n", kind: "upload", data: wav, duration: 1 });
  const s = snapshot(p);
  assert.equal(s.clips[0], p.clips[0]);
  assert.notEqual(s.clips, p.clips);
  const h = new History();
  h.push(p);
  p.clips = [];
  const back = h.undo(p)!;
  assert.equal(back.clips.length, 1);
});
