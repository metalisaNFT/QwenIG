import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanPose, fitPose, hitJoint, LIMBS, COLORS, mirrorPerson, PRESETS, presetPose, poseInstruction } from "../src/pose.ts";
import { blankProject, parseProject } from "../src/model.ts";

test("every preset has 18 joints inside the frame", () => {
  for (const name of Object.keys(PRESETS)) {
    const pose = presetPose(name, 512, 768);
    assert.equal(pose.people[0].length, 18, name);
    for (const [x, y, c] of pose.people[0]) {
      assert.ok(x >= 0 && x <= 512 && y >= 0 && y <= 768 && c === 1, `${name}: ${x},${y}`);
    }
  }
  assert.equal(LIMBS.length, 17);
  assert.equal(COLORS.length, 18);
});

test("mirroring flips x and swaps left/right joints", () => {
  const p = presetPose("Waving", 400, 800).people[0];
  const m = mirrorPerson(p, 400);
  assert.equal(m[0][0], 400 - p[0][0]); // nose
  assert.deepEqual(m[2], [400 - p[5][0], p[5][1], 1]); // right shoulder ← mirrored left shoulder
  assert.deepEqual(mirrorPerson(m, 400), p);
});

test("fitPose keeps proportions and centres", () => {
  const pose = { width: 100, height: 200, people: [[...Array(18)].map(() => [50, 100, 1] as [number, number, number])] };
  const fitted = fitPose(pose, 400, 400);
  assert.deepEqual(fitted.people[0][0], [200, 200, 1]);
});

test("cleanPose rejects junk and clamps", () => {
  assert.equal(cleanPose(null), null);
  assert.equal(cleanPose({ width: 5, height: 5, people: [] }), null);
  const person = [...Array(18)].map(() => [999, -3, 7]);
  const cleaned = cleanPose({ width: 100, height: 100, people: [person, [[1, 2, 3]]] })!;
  assert.equal(cleaned.people.length, 1);
  assert.deepEqual(cleaned.people[0][0], [100, 0, 1]);
});

test("hitJoint finds the nearest visible joint", () => {
  const pose = presetPose("Standing", 200, 400);
  const [x, y] = pose.people[0][4];
  assert.deepEqual(hitJoint(pose, x + 2, y - 1, 10), [0, 4]);
  assert.equal(hitJoint(pose, -50, -50, 10), null);
});

test("pose instructions name the right image", () => {
  assert.match(poseInstruction(3), /image 3/);
  assert.match(poseInstruction(2, true), /person in image 1 .* image 2/);
});

test("a project keeps its pose", () => {
  const p = blankProject();
  p.pose = { spec: presetPose("Running", 512, 512), enabled: true };
  const q = parseProject(JSON.stringify(p));
  assert.deepEqual(q.pose, p.pose);
  const bad = blankProject() as any;
  bad.pose = { spec: { width: 1, height: 1, people: [] }, enabled: true };
  assert.equal(parseProject(JSON.stringify(bad)).pose, undefined);
});

test("an upscaled layer's metadata survives save and reopen, even at ×4 beyond 2048 px", async () => {
  const { upscaleMetadata } = await import("../src/model.ts");
  const p = blankProject();
  p.assets.a = { id: "a", width: 1, height: 1, data: "data:image/png;base64,AAAA" };
  const source = { ...p.settings, prompt: "a fox", width: 768, height: 768, model: "qwen", jobId: "j1", createdAt: "t" };
  const meta = upscaleMetadata({ scale: 4, width: 3072, height: 3072, model: "esrgan", jobId: "j2", createdAt: "t2" }, source, p.settings);
  p.gallery.push({ id: "j2", assetId: "a", metadata: meta });
  const q = parseProject(JSON.stringify(p));
  assert.equal(q.gallery[0].metadata.kind, "upscale");
  assert.equal(q.gallery[0].metadata.prompt, "a fox");
  assert.deepEqual([q.gallery[0].metadata.scale, q.gallery[0].metadata.outputWidth], [4, 3072]);
  const orphan = upscaleMetadata({ scale: 2, width: 100, height: 100, model: "m", jobId: "j", createdAt: "t" }, undefined, p.settings);
  p.gallery[0].metadata = orphan;
  assert.equal(parseProject(JSON.stringify(p)).gallery[0].metadata.prompt, "");
});
