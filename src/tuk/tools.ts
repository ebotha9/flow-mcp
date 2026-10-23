// TUK MCP tools: mark drafts Keep/Reject, promote kept Fast drafts to Quality, and read a project's generation log.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { projectDir, type Core } from "../core.js";
import { REJECT_REASONS } from "./fields.js";
import { readLog, writeLog } from "./log.js";
import { analyseProject } from "./review.js";
import { existsSync, readFileSync } from "node:fs";
import { PORT, TOKEN_FILE } from "../server.js";

type Reply = (work: Promise<unknown>, extra?: object) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>;

export const tukShapes = {
  mark: {
    project: z.string().min(1).describe("Same project name used in flow_generate."),
    marks: z
      .array(
        z.object({
          stem: z.string().min(1).describe("File stem from the log, e.g. 'EP00_SH012_v03_F'."),
          outcome: z.enum(["Keep", "Draft", "Reject"]),
          reason: z.enum(REJECT_REASONS).optional().describe("QC category; required for Reject."),
          notes: z.string().max(500).optional().describe("What to change next time, or what makes it a keeper (usable seconds, drift)."),
          in_s: z.number().min(0).max(60).optional().describe("Use the clip from this second."),
          out_s: z.number().min(0).max(60).optional().describe("Use the clip up to this second."),
        }),
      )
      .min(1)
      .max(100),
  },
  promote: {
    project: z.string().min(1).describe("Same project name used in flow_generate."),
    drafts: z.array(z.string().min(1)).min(1).max(50).describe("Stems of Fast drafts marked Keep, e.g. ['EP00_SH012_v03_F']."),
    max_credits: z.number().int().min(0).default(100).describe("Per shot; Veo 3.1 Quality quotes 100 on Ultra. A higher quote skips the shot."),
    download_quality: z.enum(["original", "upscaled", "4k"]).default("upscaled").describe("Default: the free 1080p download."),
  },
  review: {
    project: z.string().min(1).describe("Same project name used in flow_generate."),
    stems: z.array(z.string().min(1)).optional().describe("Only these outputs. Default: every downloaded output not yet marked."),
    include_reviewed: z.boolean().default(false),
  },
  log: {
    project: z.string().min(1),
    shot_id: z.string().optional().describe("Only this shot, e.g. 'EP00_SH012'."),
  },
};

const inLog = (project: string) => projectDir(project);

export function markDrafts({ project, marks }: z.infer<z.ZodObject<typeof tukShapes.mark>>) {
  const dir = inLog(project);
  const rows = readLog(dir);
  if (!rows.length) throw new Error(`No generation log in ${dir}.`);
  const missing = marks.filter((m) => !rows.some((r) => r.Stem === m.stem));
  if (missing.length) throw new Error(`Not in the log: ${missing.map((m) => m.stem).join(", ")}. Nothing was changed.`);
  const noReason = marks.filter((m) => m.outcome === "Reject" && !m.reason);
  if (noReason.length) throw new Error(`A Reject needs a reason: ${noReason.map((m) => m.stem).join(", ")}. Nothing was changed.`);
  const notDone = marks.filter((m) => m.outcome === "Keep" && !rows.some((r) => r.Stem === m.stem && r.Status === "done"));
  if (notDone.length) throw new Error(`Only a downloaded output can be kept: ${notDone.map((m) => m.stem).join(", ")}. Nothing was changed.`);
  for (const m of marks) {
    // The newest row for a stem is the one that counts (a stem is logged again only after a failed attempt).
    const row = [...rows].reverse().find((r) => r.Stem === m.stem && (m.outcome !== "Keep" || r.Status === "done"))!;
    row.Outcome = m.outcome;
    row["Reject reason"] = m.outcome === "Reject" ? m.reason! : "";
    if (m.notes) row.Notes = [row.Notes, m.notes].filter(Boolean).join(" · ");
    if (m.in_s !== undefined) row["In (s)"] = String(m.in_s);
    if (m.out_s !== undefined) row["Out (s)"] = String(m.out_s);
  }
  writeLog(dir, rows);
  return { log: dir, marked: marks.map(({ stem, outcome }) => ({ stem, outcome })) };
}

export function readShotLog({ project, shot_id }: z.infer<z.ZodObject<typeof tukShapes.log>>) {
  const rows = readLog(inLog(project)).filter((r) => !shot_id || r.Stem.startsWith(`${shot_id}_v`));
  const credits = rows.reduce((n, r) => n + (Number(r.Credits) || 0), 0);
  return {
    rows: rows.map((r) => ({ stem: r.Stem, status: r.Status, outcome: r.Outcome, reason: r["Reject reason"], model: r.Model, credits: r.Credits, file: r["Output file"], notes: r.Notes })),
    total_credits: credits,
  };
}

export async function promoteDrafts(core: Core, { project, drafts, max_credits, download_quality }: z.infer<z.ZodObject<typeof tukShapes.promote>>) {
  const rows = readLog(inLog(project));
  const scenes = drafts.map((stem) => {
    const row = [...rows].reverse().find((r) => r.Stem === stem && r.Status === "done");
    if (!row) throw new Error(`${stem} is not a downloaded draft in this project's log.`);
    if (!/_F$/.test(stem)) throw new Error(`${stem} is not a Veo 3.1 Fast draft.`);
    if (row.Outcome !== "Keep") throw new Error(`${stem} is marked '${row.Outcome || "unreviewed"}', not Keep. Review it and mark it with flow_mark first.`);
    const [, shot_id, version] = stem.match(/^(.+)_v(\d+)_F$/)!;
    return {
      shot_id,
      version: Number(version),
      type: "video" as const,
      model: "Veo 3.1 - Quality",
      prompt: row["Prompt as written"],
      first_frame: row["First frame path"] || undefined,
      last_frame: row["Last frame path"] || undefined,
      aspect_ratio: (row["Aspect ratio"] || undefined) as "16:9" | "9:16" | undefined,
      shot_type: (row["Shot type"] || undefined) as never,
      pattern: row.Pattern || undefined,
      camera_move: row["Camera move"] || undefined,
      max_credits,
      retries: 1,
      download_quality,
    };
  });
  return core.generate({ project, scenes } as Parameters<Core["generate"]>[0]);
}

export async function reviewProject({ project, stems, include_reviewed }: z.infer<z.ZodObject<typeof tukShapes.review>>) {
  const items = await analyseProject(inLog(project), stems, !include_reviewed);
  const token = existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, "utf8").trim() : "";
  return {
    board: token ? `http://127.0.0.1:${PORT}/tuk/review?project=${encodeURIComponent(project)}&token=${token}` : "Flow Studio's server is not running, so the board is unavailable; the checks below still apply.",
    items: items.map(({ stem, kind, outcome, summary, flags, clean_window, file }) => ({ stem, kind, outcome: outcome || "unreviewed", summary, flags, clean_window, file })),
  };
}

type Patient = (tool: string, work: Promise<unknown>) => Promise<unknown>;

export function registerTukTools(server: McpServer, core: Core, reply: Reply, patient: Patient = (_t, w) => w): void {
  server.registerTool(
    "flow_mark",
    {
      title: "Mark drafts Keep or Reject (TUK)",
      description:
        "The Unreasonable Kitchen only. Record the review call for logged outputs in the project's generation-log.csv: Keep, Draft or Reject (Reject needs a QC reason). A Fast draft must be marked Keep before it can be rendered in Quality.",
      inputSchema: tukShapes.mark,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => reply(Promise.resolve().then(() => markDrafts(args))),
  );

  server.registerTool(
    "flow_promote",
    {
      title: "Render kept Fast drafts in Quality (TUK)",
      description:
        "The Unreasonable Kitchen only. Queue Veo 3.1 Quality renders of Fast drafts marked Keep, with exactly the same start frame, last frame, prompt and aspect (guard rail 7). Saved as <shot>_v<same>_Q. About 100 credits per shot on Ultra, checked against Flow's quote before anything is spent: tell the user the total and get a yes before calling. Use flow_wait for results.",
      inputSchema: tukShapes.promote,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => reply(Promise.resolve().then(() => promoteDrafts(core, args))),
  );

  server.registerTool(
    "flow_review",
    {
      title: "Review board (TUK)",
      description:
        "The Unreasonable Kitchen only. Screens downloaded outputs with ffmpeg (thumbnails every 0.5 s; something entering at the frame edges, camera drift, exposure shifts; the longest clean stretch) and returns a local review-board link where each output is marked Keep, Draft or Reject with an in/out point. The checks point at where to look; they do not decide. Open the link for the user, or mark with flow_mark after checking the frames.",
      inputSchema: tukShapes.review,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => reply(patient("flow_review", reviewProject(args))),
  );

  server.registerTool(
    "flow_log",
    {
      title: "Read the generation log (TUK)",
      description: "The Unreasonable Kitchen only. List a project's logged generations: stem, status, outcome, model, credits and file, plus the credit total.",
      inputSchema: tukShapes.log,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => reply(Promise.resolve().then(() => readShotLog(args))),
  );
}
