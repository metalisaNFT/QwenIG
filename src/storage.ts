import { parseProject, type Project } from "./model.ts";
const database = new Promise<IDBDatabase>((resolve, reject) => {
  const r = indexedDB.open("studio-zero", 1);
  r.onupgradeneeded = () => r.result.createObjectStore("projects");
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
// Serialize commits so a slow write can never overwrite a newer one.
let pending: Promise<void> = Promise.resolve();
export function saveLocal(p: Project) {
  const snapshot = JSON.stringify(p);
  const write = pending
    .catch(() => {})
    .then(async () => {
      const db = await database;
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("projects", "readwrite");
        const store = tx.objectStore("projects");
        store.put(snapshot, p.id);
        store.put(p.id, "current-id");
        store.delete("current");
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    });
  pending = write;
  return write;
}
async function read(key: string): Promise<string | undefined> {
  const db = await database;
  const value = await new Promise<string | undefined>((resolve, reject) => {
    const r = db.transaction("projects").objectStore("projects").get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return value;
}
export async function loadLocal(id?: string) {
  const currentId = id || (await read("current-id"));
  const value = await read(currentId || "current");
  return value ? parseProject(value) : null;
}
export async function listLocal() {
  await pending.catch(() => {});
  const db = await database;
  const values = await new Promise<unknown[]>((resolve, reject) => {
    const r = db.transaction("projects").objectStore("projects").getAll();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return values
    .filter((v): v is string => typeof v === "string" && v.startsWith("{"))
    .flatMap((v) => {
      try {
        const p = parseProject(v);
        const image = [...p.layers].reverse().find((l) => l.assetId);
        return [
          {
            id: p.id,
            title: p.title,
            layers: p.layers.length,
            thumbnail: image?.assetId ? p.assets[image.assetId].data : null,
          },
        ];
      } catch {
        return [];
      }
    });
}
export function download(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name.replace(/[<>:"/\\|?*]/g, "-");
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
export function readData(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
