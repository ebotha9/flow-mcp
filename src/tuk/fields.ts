// The Unreasonable Kitchen (TUK): extra per-scene fields for channel shots. They are optional, so a scene without a
// shot_id behaves exactly as upstream flow-mcp. Kept in their own module so upstream merges stay painless.
import { z } from "zod";

export const SHOT_TYPES = [
  "pour",
  "bubbling oil",
  "steam",
  "knife cut",
  "foam rise",
  "hands",
  "static food",
  "macro",
  "Impossible Kitchen",
  "still",
  "other",
] as const;

export const REJECT_REASONS = [
  "physics",
  "morphing",
  "continuity",
  "light direction",
  "set/prop drift",
  "text/logo",
  "food state",
  "too perfect",
  "hands",
  "other",
] as const;

// <episode or test>_<shot>: EP00_SH012, T02L_SH03, TST_SF01.
export const SHOT_ID = /^[A-Z][A-Z0-9]*_[A-Z]+\d+[A-Z]?$/;

export const tukSceneFields = {
  shot_id: z
    .string()
    .regex(SHOT_ID, "shot_id looks like EP00_SH012 (episode or test code, underscore, shot code)")
    .optional()
    .describe(
      "Channel shot ID, e.g. 'EP00_SH012'. Turns on shot naming (EP00_SH012_v03_F.mp4, EP00_SH012_v02_SF.jpeg, same title in Flow), the generation log and the guard-rail pre-flight. Needs an explicit model.",
    ),
  version: z
    .number()
    .int()
    .min(1)
    .max(99)
    .optional()
    .describe("Version number. Leave it out: the next free version is used, and a Quality render takes the version of its kept Fast draft."),
  shot_type: z.enum(SHOT_TYPES).optional().describe("Shot type for the generation log's keep-rate table."),
  pattern: z.string().max(40).optional().describe("Prompt-library pattern ID, if the prompt came from one."),
  camera_move: z
    .string()
    .max(300)
    .optional()
    .describe(
      "Only for a signature camera move that the edit cannot fake: say why. Requires last_frame. Without it, the prompt must hold the camera static.",
    ),
};

export interface TukScene {
  shot_id?: string;
  version?: number;
  shot_type?: (typeof SHOT_TYPES)[number];
  pattern?: string;
  camera_move?: string;
  type?: "video" | "image";
  model?: string;
  prompt: string;
  first_frame?: string;
  last_frame?: string;
  reference_images?: string[];
  variants?: number;
  aspect_ratio?: string;
  duration?: number;
  max_credits?: number;
  chain_previous?: boolean;
}

// What the job carries at run time for the log. Set by tukName() in core.generate.
export interface TukParams {
  shot_id?: string;
  version?: number;
  shot_type?: string;
  pattern?: string;
  camera_move?: string;
  prompt_as_written?: string;
  variant_stems?: string[];
}
