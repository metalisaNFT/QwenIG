import { test } from "node:test";
import assert from "node:assert/strict";
import { StudioService } from "../src/service.ts";
import { defaults } from "../src/model.ts";

test("generation sends ordered references in an authenticated JSON request", async (t) => {
  const references = [
    "data:image/png;base64,AAAA",
    "data:image/png;base64,BBBB",
  ];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://engine.example/generate");
    assert.equal(options.method, "POST");
    assert.equal(options.headers.Authorization, "Bearer test-key");
    assert.deepEqual(JSON.parse(options.body).reference_images, references);
    assert.equal(JSON.parse(options.body).width, 2048);
    return Response.json({ id: "test-job", status: "queued" }, { status: 202 });
  });
  const job = await new StudioService(
    "https://engine.example",
    "test-key",
  ).generate(
    { ...defaults, prompt: "Combine image 1 and image 2", width: 2048 },
    references,
  );
  assert.equal(job.id, "test-job");
});

test("network failures identify the browser origin without exposing the key", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("Failed to fetch");
  });
  const previous = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { origin: "http://127.0.0.1:5174" },
  });
  try {
    await assert.rejects(
      new StudioService("https://engine.example", "private-test-key").health(),
      (error: Error) => {
        assert.ok(error.message.includes("http://127.0.0.1:5174"));
        assert.ok(error.message.includes("http://127.0.0.1:5173"));
        assert.match(error.message, /ZERO_ALLOWED_ORIGINS/);
        assert.ok(!error.message.includes("private-test-key"));
        return true;
      },
    );
  } finally {
    if (previous) Object.defineProperty(globalThis, "location", previous);
    else Reflect.deleteProperty(globalThis, "location");
  }
});

test("authentication errors remain distinct from network errors", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      { detail: "A valid access key is required." },
      { status: 401 },
    ),
  );
  await assert.rejects(
    new StudioService("https://engine.example", "incorrect-key").health(),
    { message: "A valid access key is required." },
  );
});

test("timeouts explain that the engine did not respond", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new DOMException("Timed out", "TimeoutError");
  });
  await assert.rejects(
    new StudioService("https://engine.example", "test-key").health(),
    /engine took too long to respond/,
  );
});

test("health checks retain bearer authentication and return the API response", async (t) => {
  const health = {
    ready: true,
    mode: "demo",
    message: "Ready",
    capabilities: ["text-to-image"],
  };
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://engine.example/health");
    assert.equal(options.headers.Authorization, "Bearer test-key");
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    return Response.json(health);
  });
  assert.deepEqual(
    await new StudioService("https://engine.example/", "test-key").health(),
    health,
  );
});

test("background removal uploads one image and polls a short-lived task", async (t) => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, options: any) => {
    calls.push(`${options.method} ${url}`);
    if (url.endsWith("/remove-background")) {
      assert.equal(options.headers.Authorization, "Bearer test-key");
      assert.equal(
        JSON.parse(options.body).image,
        "data:image/png;base64,AAAA",
      );
      return Response.json({ id: "t1", status: "queued" }, { status: 202 });
    }
    if (url.endsWith("/tasks/t1"))
      return Response.json({ id: "t1", status: "succeeded" });
    if (url.endsWith("/tasks/t1/mask"))
      return new Response(new Blob(["png"], { type: "image/png" }));
    return Response.json({ id: "t1", status: "cancelled" });
  });
  const service = new StudioService("https://engine.example", "test-key");
  assert.equal(
    (await service.removeBackground("data:image/png;base64,AAAA")).id,
    "t1",
  );
  assert.equal((await service.task("t1")).status, "succeeded");
  assert.equal((await service.taskMask("t1")).type, "image/png");
  assert.equal((await service.cancelTask("t1")).status, "cancelled");
  assert.deepEqual(calls, [
    "POST https://engine.example/remove-background",
    "GET https://engine.example/tasks/t1",
    "GET https://engine.example/tasks/t1/mask",
    "POST https://engine.example/tasks/t1/cancel",
  ]);
});
