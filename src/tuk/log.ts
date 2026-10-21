// TUK generation log: one CSV per project folder, one row per generated output (each variant is its own row).
// The first 18 columns match the channel's generation-log workbook (tuk-generation-log imports them as they are);
// the rest are working columns the tool needs for promotion and the retry budget.
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Job } from "../queue.js";
import type { TukParams } from "./fields.js";

export const LOG_FILE = "generation-log.csv";

export const COLUMNS = [
  "Date",
  "Episode",
  "Shot",
  "Version",
  "Shot type",
  "Asset",
  "Model",
  "Mode",
  "Aspect",
  "Length (s)",
  "Start frame",
  "Prompt",
  "Pattern",
  "Credits",
  "Outcome",
  "Reject reason",
  "Notes",
  "Output file",
  // Working columns.
  "Stem",
  "Status",
  "Job ID",
  "Quoted credits",
  "Variants",
  "Prompt as written",
  "First frame path",
  "Last frame path",
  "Reference images",
  "Aspect ratio",
  "Camera move",
  "Error",
  "Output path",
  "Logged at",
  // Review: the part of the clip to use, in seconds (set with flow_mark or the review board).
  "In (s)",
  "Out (s)",
] as const;

export type Row = Record<(typeof COLUMNS)[number], string>;

const csvCell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const csvLine = (row: Partial<Row>) => COLUMNS.map((c) => csvCell(row[c] ?? "")).join(",") + "\r\n";

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c !== ""));
}

export function readLog(dir: string): Row[] {
  const file = join(dir, LOG_FILE);
  if (!existsSync(file)) return [];
  const [header, ...body] = parseCsv(readFileSync(file, "utf8"));
  if (!header) return [];
  return body.map((cells) => Object.fromEntries(COLUMNS.map((c) => [c, cells[header.indexOf(c)] ?? ""])) as Row);
}

export function appendRows(dir: string, rows: Partial<Row>[]): void {
  if (!rows.length) return;
  const file = join(dir, LOG_FILE);
  // A BOM so Excel opens the file as UTF-8 (prompts carry °, ×, em dashes).
  if (!existsSync(file)) writeFileSync(file, "﻿" + COLUMNS.map(csvCell).join(",") + "\r\n", "utf8");
  appendFileSync(file, rows.map(csvLine).join(""), "utf8");
}

// Rewrites the file through a temp file so a crash mid-write never leaves half a log.
export function writeLog(dir: string, rows: Row[]): void {
  const file = join(dir, LOG_FILE);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, "﻿" + COLUMNS.map(csvCell).join(",") + "\r\n" + rows.map(csvLine).join(""), "utf8");
  renameSync(tmp, file);
}

export const normPrompt = (p: string) => p.trim().replace(/\s+/g, " ").replace(/\.$/, "");
export const normPath = (p?: string) => (p ?? "").trim().replace(/\\/g, "/").toLowerCase();

export function modelLabel(model?: string, type?: string): string {
  if (!model) return type === "image" ? "Nano Banana (default)" : "Flow default";
  return model.replace(/\s*-\s*/, " ").replace(/\s+/g, " ").trim();
}

export function modeOf(p: { type?: string; first_frame?: string; last_frame?: string; reference_images?: string[]; edit_asset?: string; continue_from?: string }): string {
  if (p.edit_asset) return "Video edit";
  if (p.continue_from) return "Continue (agent)";
  if (p.type === "video" && p.first_frame && p.last_frame) return "Frames (first + last)";
  if (p.type === "video" && p.first_frame) return "Frames (first)";
  if (p.type === "video" && p.last_frame) return "Frames (last)";
  if (p.reference_images?.length) return "Ingredients";
  return "Text";
}

// Either separator, so a Windows path reads right whichever OS wrote the log.
const basename = (f: string) => f.split(/[\\/]/).pop() ?? f;
const frameName = (f?: string) => (!f ? "" : f.startsWith("asset:") ? f.slice(6) : basename(f));
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// Turns a finished or failed job into log rows: one per expected output.
export function rowsForJob(job: Job): Partial<Row>[] {
  const p = job.params as Job["params"] & TukParams;
  const stems = p.variant_stems?.length ? p.variant_stems : p.agent_scenes ? [p.file_stem] : Array.from({ length: p.variants ?? 1 }, (_, i) => ((p.variants ?? 1) > 1 ? `${p.file_stem}-v${i + 1}` : p.file_stem));
  const [episode, shot] = p.shot_id ? p.shot_id.split("_") : ["", p.file_stem];
  const quoted = job.credits;
  // Flow quotes the whole generation (all variants). Nothing is spent when the quote was refused before Start.
  const nothingSpent = job.status === "failed" && /nothing was generated/i.test(job.error ?? "");
  const perOutput = quoted === undefined || nothingSpent ? 0 : Math.round(quoted / Math.max(1, stems.length));
  const length = p.type === "image" ? "" : String(p.duration ?? (/veo/i.test(p.model ?? "") ? 8 : ""));
  const startFrame = p.type === "image" ? (p.reference_images ?? []).map(frameName).join(" + ") : frameName(p.first_frame);
  return stems.map((stem) => {
    const file = job.files.find((f) => basename(f).replace(/\.[^.]+$/, "") === stem) ?? (stems.length === 1 ? job.files[0] : undefined);
    const version = stem.match(/_v(\d+)/)?.[1];
    return {
      Date: today(),
      Episode: episode ?? "",
      Shot: shot ?? "",
      Version: version ? `v${version}` : "",
      "Shot type": p.shot_type ?? (p.type === "image" ? "still" : ""),
      Asset: p.type === "image" ? "Start frame" : "Video",
      Model: modelLabel(p.model, p.type),
      Mode: modeOf(p),
      Aspect: p.aspect_ratio ?? "",
      "Length (s)": length,
      "Start frame": startFrame,
      Prompt: p.prompt,
      Pattern: p.pattern ?? "",
      Credits: String(perOutput),
      Outcome: "",
      "Reject reason": "",
      Notes: [job.note, file || job.status !== "done" ? "" : "not downloaded: fetch from Flow with flow_download"].filter(Boolean).join(" · "),
      "Output file": file ? basename(file) : "",
      Stem: stem,
      Status: file ? "done" : job.status === "cancelled" ? "cancelled" : "failed",
      "Job ID": job.id,
      "Quoted credits": quoted === undefined ? "" : String(quoted),
      Variants: String(stems.length),
      "Prompt as written": p.prompt_as_written ?? p.prompt,
      "First frame path": p.first_frame ?? "",
      "Last frame path": p.last_frame ?? "",
      "Reference images": (p.reference_images ?? []).join(" | "),
      "Aspect ratio": p.aspect_ratio ?? "",
      "Camera move": p.camera_move ?? "",
      Error: job.error ?? "",
      "Output path": file ?? "",
      "Logged at": new Date().toISOString(),
    };
  });
}

// Never lets a logging problem (a locked file, a full drive) fail or hide the generation itself: it comes back as a note.
export function logJob(job: Job): string | undefined {
  try {
    appendRows(job.params.output_dir, rowsForJob(job));
    return undefined;
  } catch (err) {
    return `generation log not written: ${err instanceof Error ? err.message : String(err)}`;
  }
}
