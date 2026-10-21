// TUK review board: per-clip analysis (thumbnails every 0.5 s, plus checks for something entering at the frame edges,
// camera drift and exposure shifts) and a local page to mark each output Keep or Reject with an in/out point.
// The checks are a screening aid, calibrated on TST_SH01_v01_F (an arm entering from frame left at 0.5-2.0 s):
// they point at where to look, they do not decide.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { FFMPEG_HINT } from "../platform.js";
import { readLog, type Row } from "./log.js";

const run = promisify(execFile);
const FFMPEG = process.env.FLOW_MCP_FFMPEG ?? "ffmpeg";

const W = 96;
const H = 54;
const FPS = 8; // analysis frames per second
const COLS = 12; // 8 px blocks
const ROWS = 6; // 9 px blocks
const LOCAL = 20; // a block this far off frame 0 (after removing the global brightness shift) is a big local change
const DRIFT = 4; // median block change above this: the whole frame moved (camera drift or zoom)
const EXPOSURE = 6; // global brightness change above this
const CLEAN_LOCAL = 15;

export interface Flag {
  kind: "edge" | "local" | "drift" | "exposure";
  where?: string;
  from: number;
  to: number;
}

export interface Analysis {
  stem: string;
  file: string;
  kind: "video" | "image";
  duration?: number;
  thumbs: string[]; // file names inside the review folder, one per 0.5 s
  flags: Flag[];
  clean_window?: { from: number; to: number };
  summary: string;
}

export const reviewDir = (projectDir: string) => join(projectDir, "review");

async function ffmpeg(args: string[], maxBuffer = 64 * 1024 * 1024): Promise<Buffer> {
  try {
    const { stdout } = await run(FFMPEG, args, { encoding: "buffer", maxBuffer, windowsHide: true });
    return stdout as unknown as Buffer;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer };
    throw new Error(e.code === "ENOENT" ? `The review board needs ffmpeg (${FFMPEG_HINT}).` : `ffmpeg failed: ${String(e.stderr ?? e).slice(-400)}`);
  }
}

const edgeName = (c: number, r: number) =>
  [c === 0 ? "left" : c === COLS - 1 ? "right" : "", r === 0 ? "top" : r === ROWS - 1 ? "bottom" : ""].filter(Boolean).join("-");

// Merges per-sample hits into time ranges.
function ranges(hits: { t: number; key: string }[], kind: Flag["kind"]): Flag[] {
  const out: Flag[] = [];
  const step = 1 / FPS;
  for (const h of hits) {
    let last: Flag | undefined;
    for (const f of out) if (f.where === (h.key || undefined)) last = f;
    if (last && h.t - last.to <= step * 1.5) last.to = h.t;
    else out.push({ kind, where: h.key || undefined, from: h.t, to: h.t });
  }
  return out;
}

export function analyseFrames(raw: Buffer): { flags: Flag[]; clean_window?: { from: number; to: number }; duration: number } {
  const size = W * H;
  const n = Math.floor(raw.length / size);
  if (!n) return { flags: [], duration: 0 };
  const mean = (i: number) => {
    let s = 0;
    for (let k = 0; k < size; k++) s += raw[i * size + k];
    return s / size;
  };
  const m0 = mean(0);
  const edge: { t: number; key: string }[] = [];
  const local: { t: number; key: string }[] = [];
  const drift: { t: number; key: string }[] = [];
  const expo: { t: number; key: string }[] = [];
  const clean: boolean[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / FPS;
    const shift = mean(i) - m0;
    const blocks: number[] = [];
    let worst = 0;
    let worstAt = "";
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++) {
        let s = 0;
        for (let y = r * 9; y < r * 9 + 9; y++)
          for (let x = c * 8; x < c * 8 + 8; x++) s += Math.abs(raw[i * size + y * W + x] - raw[y * W + x] - shift);
        const v = s / 72;
        blocks.push(v);
        if (v > worst) {
          worst = v;
          worstAt = edgeName(c, r);
        }
      }
    const median = [...blocks].sort((a, b) => a - b)[Math.floor(blocks.length / 2)];
    if (worst > LOCAL) (worstAt ? edge : local).push({ t, key: worstAt });
    if (median > DRIFT) drift.push({ t, key: "" });
    if (Math.abs(shift) > EXPOSURE) expo.push({ t, key: "" });
    clean.push(worst <= CLEAN_LOCAL && median <= DRIFT && Math.abs(shift) <= EXPOSURE);
  }
  // The longest run of clean samples is the best candidate for the cut.
  let best: { from: number; to: number } | undefined;
  let start = -1;
  for (let i = 0; i <= n; i++) {
    if (i < n && clean[i]) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      const span = { from: start / FPS, to: (i - 1) / FPS };
      if (!best || span.to - span.from > best.to - best.from) best = span;
      start = -1;
    }
  }
  const round = (f: Flag) => ({ ...f, from: Math.round(f.from * 4) / 4, to: Math.round(f.to * 4) / 4 });
  return {
    flags: [...ranges(edge, "edge"), ...ranges(local, "local"), ...ranges(drift, "drift"), ...ranges(expo, "exposure")].map(round),
    clean_window: best && best.to - best.from >= 1 ? { from: Math.round(best.from * 4) / 4, to: Math.round(best.to * 4) / 4 } : undefined,
    duration: n / FPS,
  };
}

const describe = (a: { flags: Flag[]; clean_window?: { from: number; to: number } }) => {
  const text = a.flags.map((f) =>
    f.kind === "edge"
      ? `something changes at the ${f.where} edge ${f.from}-${f.to} s (a hand or person entering?)`
      : f.kind === "local"
        ? `large local change ${f.from}-${f.to} s (the intended action, or something appearing)`
        : f.kind === "drift"
          ? `whole frame moves ${f.from}-${f.to} s (camera drift or zoom)`
          : `exposure shifts ${f.from}-${f.to} s`,
  );
  return [text.length ? text.join("; ") : "no edge entries, drift or exposure shifts detected", a.clean_window ? `clean ${a.clean_window.from}-${a.clean_window.to} s` : "no clean second-long stretch"].join(". ");
};

export async function analyse(projectDir: string, row: Row): Promise<Analysis> {
  const dir = reviewDir(projectDir);
  mkdirSync(dir, { recursive: true });
  const file = row["Output path"] || join(projectDir, row["Output file"]);
  const cache = join(dir, `${row.Stem}.json`);
  if (existsSync(cache)) {
    const hit = JSON.parse(readFileSync(cache, "utf8")) as Analysis;
    if (hit.file === file) return hit;
  }
  if (!existsSync(file)) throw new Error(`${row.Stem}: ${file} is not on disk.`);
  let result: Analysis;
  if (/\.(jpe?g|png|webp)$/i.test(file)) {
    result = { stem: row.Stem, file, kind: "image", thumbs: [], flags: [], summary: "still: compare with its reference" };
  } else {
    // Thumbnails at 0, 0.5, 1 ... s, for the page.
    await ffmpeg(["-v", "error", "-y", "-i", file, "-vf", "fps=2,scale=320:-2", "-q:v", "4", join(dir, `${row.Stem}_t%02d.jpg`)]);
    const thumbs = readdirSync(dir).filter((f) => f.startsWith(`${row.Stem}_t`) && f.endsWith(".jpg")).sort();
    const raw = await ffmpeg(["-v", "error", "-i", file, "-vf", `fps=${FPS},scale=${W}:${H},format=gray`, "-f", "rawvideo", "-"]);
    const a = analyseFrames(raw);
    result = { stem: row.Stem, file, kind: "video", duration: a.duration, thumbs, flags: a.flags, clean_window: a.clean_window, summary: describe(a) };
  }
  writeFileSync(cache, JSON.stringify(result, null, 2));
  return result;
}

export async function analyseProject(projectDir: string, stems?: string[], unreviewedOnly = true) {
  const rows = readLog(projectDir).filter(
    (r) => r.Status === "done" && (stems ? stems.includes(r.Stem) : !unreviewedOnly || !r.Outcome),
  );
  // One row per stem: the newest.
  const latest = [...new Map(rows.map((r) => [r.Stem, r])).values()];
  const out: (Analysis & { outcome: string })[] = [];
  for (const r of latest) out.push({ ...(await analyse(projectDir, r)), outcome: r.Outcome });
  return out;
}
