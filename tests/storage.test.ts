import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { blankProject, newLayer } from "../src/model.ts";
import { saveLocal, loadLocal, listLocal } from "../src/storage.ts";
test("library preserves previous projects and serialized saves resolve to the latest edit", async () => {
  const a = blankProject(),
    b = blankProject();
  a.title = "First study";
  a.layers.push(newLayer("note", 0, 0));
  await saveLocal(a);
  b.title = "Second study";
  await saveLocal(b);
  assert.equal((await loadLocal())?.id, b.id);
  assert.equal((await loadLocal(a.id))?.title, "First study");
  const writes = [];
  for (let i = 0; i < 4; i++) {
    b.title = `Revision ${i}`;
    writes.push(saveLocal(b));
  }
  await Promise.all(writes);
  assert.equal((await loadLocal())?.title, "Revision 3");
  const list = await listLocal();
  assert.equal(list.length, 2);
  assert.equal(list.find((p) => p.id === a.id)?.layers, 1);
});
