/**
 * Shared controls for glitch effects: preset chips, an ordered stack of effects with a strength
 * each, and a seed with a dice button. Used by Edit → Glitch & filters and the frame editor.
 */
import { EFFECTS, PRESETS, cleanStack, type StackItem } from "./glitch.ts";
import { h } from "./studio-context.ts";

// The last stack and seed are shared between the layer card and the frame editor in this tab.
let lastStack: StackItem[] = structuredClone(PRESETS[0].stack);
let lastSeed = 1;

export function stackEditor(onChange: () => void, prefix: string) {
  let stack = cleanStack(lastStack);
  const presets = h(
    "div",
    { class: "chips glitch-presets", role: "group", "aria-label": "Presets" },
    ...PRESETS.map((p) => {
      const chip = h("button", { type: "button", class: "chip", text: p.name, "data-preset": p.name });
      chip.onclick = () => {
        stack = structuredClone(p.stack);
        changed();
      };
      return chip;
    }),
  );
  const rows = h("div", { class: "glitch-stack", id: `${prefix}-stack` });
  const add = h("button", { type: "button", class: "quiet tiny", id: `${prefix}-add`, text: "＋ Add effect" });
  add.onclick = () => {
    const unused = EFFECTS.find((e) => !stack.some((s) => s.id === e.id)) ?? EFFECTS[0];
    stack.push({ id: unused.id, strength: 0.5 });
    changed();
  };
  const seed = h("input", { type: "number", id: `${prefix}-seed`, min: 1, max: 999999, value: lastSeed, "aria-label": "Seed" }) as HTMLInputElement;
  const dice = h("button", { type: "button", class: "quiet tiny", id: `${prefix}-dice`, title: "New random seed", text: "🎲 Shuffle" });
  dice.onclick = () => {
    seed.value = String(1 + Math.floor(Math.random() * 999998));
    changed(false);
  };
  seed.onchange = () => changed(false);

  function changed(rebuild = true) {
    lastStack = structuredClone(stack);
    lastSeed = Math.max(1, Math.round(+seed.value) || 1);
    if (rebuild) render();
    onChange();
  }
  function render() {
    rows.replaceChildren(
      ...stack.map((item, i) => {
        const pick = h(
          "select",
          { "aria-label": `Effect ${i + 1}`, class: "glitch-pick" },
          ...EFFECTS.map((e) => h("option", { value: e.id, text: e.label, selected: e.id === item.id, title: e.hint })),
        ) as HTMLSelectElement;
        pick.onchange = () => {
          item.id = pick.value;
          changed();
        };
        const strength = h("input", { type: "range", min: 0, max: 100, value: Math.round(item.strength * 100), "aria-label": "Strength" }) as HTMLInputElement;
        const value = h("output", { text: `${Math.round(item.strength * 100)}` });
        strength.oninput = () => {
          item.strength = +strength.value / 100;
          value.textContent = strength.value;
          changed(false);
        };
        const remove = h("button", { type: "button", class: "quiet tiny", title: "Remove effect", "aria-label": "Remove effect", text: "✕" });
        remove.onclick = () => {
          stack.splice(i, 1);
          changed();
        };
        const effect = EFFECTS.find((e) => e.id === item.id)!;
        return h("div", { class: "glitch-row", title: effect.hint }, pick, strength, value, remove);
      }),
    );
    if (!stack.length) rows.append(h("p", { class: "subtle", text: "No effects. Pick a preset or add one." }));
    add.hidden = stack.length >= 6;
  }
  render();
  const element = h(
    "div",
    { class: "glitch-editor" },
    presets,
    rows,
    h("div", { class: "ai-row glitch-seed" }, add, h("label", {}, "Seed ", seed), dice),
  );
  return {
    element,
    stack: () => structuredClone(stack),
    seed: () => Math.max(1, Math.round(+seed.value) || 1),
  };
}
