import { bounds, locked, type Layer, type Project } from "./model.ts";
import { layerBounds } from "./geometry.ts";

export type Alignment =
  "left" | "center" | "right" | "top" | "middle" | "bottom";
export const notePalette = {
  sage: ["#dfedb5", "#34452e"],
  sand: ["#edddba", "#51432b"],
  rose: ["#e5c6c2", "#563b3a"],
  sky: ["#c4dce0", "#304e57"],
} as const;
export function movable(project: Project, ids: Set<string>) {
  return project.layers.filter((l) => ids.has(l.id) && !locked(project, l));
}
export function alignLayers(
  project: Project,
  ids: Set<string>,
  direction: Alignment,
) {
  const all = project.layers.filter((l) => ids.has(l.id));
  const b = bounds(all);
  if (!b || all.length < 2) return;
  for (const l of movable(project, ids)) {
    const box = layerBounds(l);
    if (direction === "left") l.x += b.x - box.x;
    if (direction === "center") l.x += b.x + (b.width - box.width) / 2 - box.x;
    if (direction === "right") l.x += b.x + b.width - box.width - box.x;
    if (direction === "top") l.y += b.y - box.y;
    if (direction === "middle")
      l.y += b.y + (b.height - box.height) / 2 - box.y;
    if (direction === "bottom") l.y += b.y + b.height - box.height - box.y;
  }
}
export function reorderLayers(
  project: Project,
  ids: Set<string>,
  direction: number,
) {
  const selected = new Set(movable(project, ids).map((l) => l.id));
  const list = project.layers;
  const indices = direction > 0 ? [...list.keys()].reverse() : [...list.keys()];
  for (const index of indices) {
    const other = index + direction;
    if (
      other < 0 ||
      other >= list.length ||
      !selected.has(list[index].id) ||
      selected.has(list[other].id)
    )
      continue;
    [list[index], list[other]] = [list[other], list[index]];
  }
}
export function duplicateLayers(
  project: Project,
  ids: Set<string>,
  offset = 30,
): Layer[] {
  const originals = project.layers.filter((l) => ids.has(l.id));
  const idMap = new Map(originals.map((l) => [l.id, crypto.randomUUID()]));
  const copies = originals.map((l) => {
    const copy: Layer = {
      ...structuredClone(l),
      id: idMap.get(l.id)!,
      x: l.x + offset,
      y: l.y + offset,
      locked: false,
      groupId: null,
      name: `${l.name} copy`.slice(0, 200),
    };
    if (copy.mask && idMap.has(copy.mask.targetLayerId))
      copy.mask.targetLayerId = idMap.get(copy.mask.targetLayerId)!;
    return copy;
  });
  project.layers.push(...copies);
  return copies;
}
