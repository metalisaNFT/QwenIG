/**
 * Engine-backed tools and where they live. Each is offered only when the engine advertises
 * its capability in /health; none of them manipulate runner commands.
 *
 * - text-to-image, reference, transparent  → Create tab (main.ts)
 * - edit, inpaint, outpaint, image-to-image, variations → AI edit card (layer-ai.ts, ai-edit.ts)
 * - remove-background → Layer mask card (main.ts, background.ts) and sprite clean-up (animate.ts)
 * - video → Animate tab (animate.ts, video.ts)
 * Local, engine-free tools: pixel workshop (image-editor.ts), pixel art (pixel-art.ts), sprites (sprites.ts).
 *
 * Still planned: AI upscale, control conditioning (pose/depth), batch scheduling.
 */
export const plannedTools = ["upscale", "control", "batch"] as const;
