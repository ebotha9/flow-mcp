// TUK shot naming and guard-rail pre-flight (project instructions section 6; Prompt library/veo-prompt-rules.md).
// Runs before anything is queued: one error anywhere refuses the whole call, so no credit is spent on a broken list.
import { existsSync, readdirSync } from "node:fs";
import type { Job } from "../queue.js";
import type { TukParams, TukScene } from "./fields.js";
import { normPath, normPrompt, readLog, type Row } from "./log.js";

// veo-prompt-rules.md, "Banned words". Naming gear makes Veo draw it in the shot.
export const BANNED_WORDS = [
  "tripod",
  "slider",
  "gimbal",
  "rig",
  "crane",
  "dolly",
  "jib",
  "steadicam",
  "stabilizer",
  "handheld",
  "hand-held",
  "camera operator",
  "operator",
  "crew",
  "cameraman",
  "light stand",
  "softbox",
  "c-stand",
  "boom",
  "microphone",
  "mic",
  "clapper",
];
const BANNED = new RegExp(`\\b(${BANNED_WORDS.map((w) => w.replace(/[-]/g, "[- ]?")).join("|")})s?\\b`, "gi");

const STATIC_HOLD = /\b(static|holds? (perfectly |completely |absolutely )?still|does not (move|zoom|drift)|fixed frame|fixed, static)\b/i;
const CAMERA_WORD = /\b(camera|frame|framing|shot|lens|view)\b/i;
const NO_PEOPLE = /\bempty of people\b/i;
const MENTIONS_BURNERS = /\b(burners?|range|stove|cooktop|hob)\b/i;
const BURNER_STATE = /\bburners?\b[^.]*\b(stay|stays|remain|remains|are|is)\b[^.]*\b(off|unlit|out)\b/i;
const MENTIONS_LID = /\blid\b/i;
const LID_STATE = /\blid\b[^.]*\b(stays|stay|remains|remain|is|rests)\b/i;
const ASKS_FOR_READOUT = /\d+\s*°\s*[FC]\b|\b(reads|showing|displays)\s+\d/i;

export type Suffix = "F" | "Q" | "L" | "O" | "SF";

export function suffixFor(type: string | undefined, model: string | undefined): Suffix | undefined {
  if (type === "image") return "SF";
  if (!model) return undefined;
  if (/quality/i.test(model)) return "Q";
  if (/fast/i.test(model)) return "F";
  if (/lite/i.test(model)) return "L";
  if (/omni/i.test(model)) return "O";
  return undefined;
}

export const stemOf = (shot: string, version: number, suffix: Suffix) => `${shot}_v${String(version).padStart(2, "0")}_${suffix}`;
const parseStem = (stem: string) => {
  const m = stem.match(/^(.+)_v(\d+)_(F|Q|L|O|SF)(?:\b|$)/);
  return m ? { shot: m[1], version: Number(m[2]), suffix: m[3] as Suffix } : undefined;
};

// Drafts (F, L, O) share one version counter per shot; Q reuses the version of the Fast draft it renders; start frames count on their own.
const sameCounter = (a: Suffix, b: Suffix) => (a === "SF" ? b === "SF" : b === "F" || b === "L" || b === "O");

export interface TukPlan {
  version: number;
  variant_stems: string[];
  prompt_as_written: string;
}

export interface Prepared {
  plans: (TukPlan | undefined)[];
  warnings: string[];
}

const fmt = (rows: Row[]) => rows.map((r) => r.Stem).join(", ");

export function prepareShots(scenes: TukScene[], output_dir: string, queued: Job[]): Prepared {
  const errors: string[] = [];
  const warnings: string[] = [];
  const plans: (TukPlan | undefined)[] = [];
  const log = readLog(output_dir);
  const onDisk = existsSync(output_dir) ? readdirSync(output_dir) : [];
  // Every stem already taken: on disk, in the log, in the queue, or earlier in this call.
  const taken: string[] = [
    ...onDisk.map((f) => f.replace(/\.[^.]+$/, "")),
    ...log.map((r) => r.Stem),
    ...queued.flatMap((j) => (j.params as TukParams).variant_stems ?? []),
  ];
  // Drafts queued or planned with the same shot, start frame and prompt, for the retry budget.
  const pending: { shot: string; frame: string; prompt: string; count: number }[] = queued
    .filter((j) => (j.status === "queued" || j.status === "running") && (j.params as TukParams).shot_id)
    .map((j) => ({
      shot: (j.params as TukParams).shot_id!,
      frame: normPath(j.params.first_frame),
      prompt: normPrompt((j.params as TukParams).prompt_as_written ?? j.params.prompt),
      count: (j.params as TukParams).variant_stems?.length ?? 1,
    }));

  for (const [i, s] of scenes.entries()) {
    if (!s.shot_id) {
      plans.push(undefined);
      continue;
    }
    const at = `Scene ${i + 1} (${s.shot_id})`;
    const fail = (msg: string) => errors.push(`${at}: ${msg}`);
    const warn = (msg: string) => warnings.push(`${at}: ${msg}`);
    const type = s.type ?? "video";
    const suffix = suffixFor(type, s.model);
    const variants = s.variants ?? 1;
    const prompt = normPrompt(s.prompt);
    const frame = normPath(s.first_frame);
    const banned = [...new Set((s.prompt.match(BANNED) ?? []).map((w) => w.toLowerCase()))];

    if (!s.model) fail(`set the model explicitly (e.g. 'Veo 3.1 - Fast', 'Veo 3.1 - Quality', 'Nano Banana Pro'); Flow's current model is not used for shots.`);
    else if (!suffix) fail(`model '${s.model}' is not one the shot naming knows (Veo 3.1 Fast/Quality/Lite, Omni, or an image model).`);

    if (type === "image") {
      // Start frames are edits of approved masters, never fresh text-only generations (project instructions §7).
      if (!s.reference_images?.length) fail("a start frame must be built from a Set Bible master: pass the master (and any Prop Bible sheet) in reference_images.");
      if (banned.length) warn(`names camera gear (${banned.join(", ")}); the image model may draw it in the frame.`);
      if (!NO_PEOPLE.test(s.prompt)) warn("add 'The kitchen is empty of people.'");
    } else {
      if (banned.length) fail(`banned words (${banned.join(", ")}): Veo draws named gear in the shot. Describe what the frame does instead (veo-prompt-rules.md).`);
      if (!s.first_frame && !s.chain_previous) fail("grounded shots start from a start frame made from a Set Bible master: set first_frame.");
      const firstSentence = s.prompt.trim().split(/(?<=[.!?])\s+/)[0] ?? "";
      if (!CAMERA_WORD.test(firstSentence)) fail("the camera line comes first (Camera → Subject → Action → Context → Style → Audio). Open with what the frame does.");
      if (s.camera_move) {
        if (!s.last_frame) fail("a generated camera move needs a last_frame (an edit or crop of the first) so Veo has a fixed destination.");
        if (STATIC_HOLD.test(s.prompt)) warn("the prompt has static-hold wording and a camera move; never mix the two.");
      } else if (!STATIC_HOLD.test(s.prompt)) {
        fail("hold the camera static ('The camera is completely static: the framing does not move, zoom or drift at any point.'), or give camera_move with a last_frame for a signature move.");
      }
      if (!NO_PEOPLE.test(s.prompt)) fail("write the room's state: 'The kitchen is empty of people.' Veo fills silence with invention.");
      if (MENTIONS_BURNERS.test(s.prompt) && !BURNER_STATE.test(s.prompt)) warn("say what the other burners do ('The other burners stay off.').");
      if (MENTIONS_LID.test(s.prompt) && !LID_STATE.test(s.prompt)) warn("say where the lid is and that it stays there.");
      if (ASKS_FOR_READOUT.test(s.prompt)) warn("asks Veo to show a number or reading. Readouts are added in the edit, never generated.");
      if (!s.last_frame) warn("no last_frame: consider the start frame itself (or the end-state frame) as last_frame to pin the framing.");
    }
    if (!suffix || errors.some((e) => e.startsWith(at))) {
      plans.push(undefined);
      continue;
    }

    const shotRows = log.filter((r) => r.Stem.startsWith(`${s.shot_id}_v`));
    const sameInputs = (r: Row) => normPrompt(r["Prompt as written"]) === prompt && normPath(r["First frame path"]) === frame && normPath(r["Last frame path"]) === normPath(s.last_frame);
    let version: number;

    if (suffix === "Q") {
      // Guard rail 7: Quality only after the same start frame and prompt passed on Fast.
      const kept = shotRows.filter((r) => parseStem(r.Stem)?.suffix === "F" && r.Status === "done" && r.Outcome === "Keep" && sameInputs(r));
      const pick = s.version ? kept.find((r) => parseStem(r.Stem)?.version === s.version) : kept.sort((a, b) => parseStem(b.Stem)!.version - parseStem(a.Stem)!.version)[0];
      if (!pick) {
        fail(
          `Quality needs a Fast draft of this shot${s.version ? ` (v${String(s.version).padStart(2, "0")})` : ""} marked Keep, with the same start frame, last frame and prompt. ` +
            (shotRows.length ? `Logged for this shot: ${fmt(shotRows)}.` : "Nothing is logged for this shot yet.") +
            " Mark the draft with flow_mark, or use flow_promote.",
        );
        plans.push(undefined);
        continue;
      }
      version = parseStem(pick.Stem)!.version;
      if (variants > 1) fail("Quality renders one output per shot (100 credits each): set variants to 1.");
      const stem = stemOf(s.shot_id, version, "Q");
      const rendered = log.some((r) => r.Stem === stem && r.Status === "done") || queued.some((j) => (j.status === "queued" || j.status === "running") && (j.params as TukParams).variant_stems?.includes(stem));
      if (rendered) fail(`${stem} already exists or is queued. A second Quality render of the same draft spends 100 credits for the same shot.`);
    } else {
      if (s.version) version = s.version;
      else {
        const used = taken.map(parseStem).filter((p) => p && p.shot === s.shot_id && sameCounter(suffix, p.suffix)).map((p) => p!.version);
        version = Math.max(0, ...used) + 1;
      }
      if (suffix === "F" || suffix === "L" || suffix === "O") {
        // Guard rail 7: at most two Fast generations per shot design (same start frame and prompt).
        const tried = shotRows.filter((r) => parseStem(r.Stem)?.suffix === suffix && r.Status === "done" && sameInputs(r));
        const keep = tried.find((r) => r.Outcome === "Keep");
        const inFlight = pending.filter((p) => p.shot === s.shot_id && p.frame === frame && p.prompt === prompt).reduce((n, p) => n + p.count, 0);
        const total = tried.length + inFlight + variants;
        if (keep) warn(`${keep.Stem} is already marked Keep with these inputs; this spends more on a shot that has passed.`);
        else if (total > 2)
          fail(
            `retry budget: this would be generation ${total} of the same start frame and prompt (${tried.length} logged${inFlight ? `, ${inFlight} queued` : ""}). ` +
              "Two Fast tries is the limit: redesign the shot (scale, angle, length, partial frame, or move the motion into the edit) before spending more.",
          );
      }
    }

    const stems = Array.from({ length: suffix === "Q" ? 1 : variants }, (_, k) => stemOf(s.shot_id!, version + k, suffix));
    const clash = stems.filter((st) => taken.includes(st));
    if (clash.length && suffix !== "Q") fail(`${clash.join(", ")} already exists or is queued; leave version out to take the next free one.`);
    taken.push(...stems);
    if (suffix !== "Q" && suffix !== "SF") pending.push({ shot: s.shot_id, frame, prompt, count: stems.length });
    plans.push({ version, variant_stems: stems, prompt_as_written: s.prompt });
  }

  if (errors.length) throw new Error(`Pre-flight refused this call; nothing was queued and no credits were spent.\n- ${errors.join("\n- ")}${warnings.length ? `\nWarnings:\n- ${warnings.join("\n- ")}` : ""}`);
  return { plans, warnings };
}
