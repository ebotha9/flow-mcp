# TUK additions (The Unreasonable Kitchen)

Channel-specific additions to flow-mcp. They live here so `git merge upstream/main` or a rebase stays painless. A scene without `shot_id` behaves exactly as upstream.

## Hooks into upstream files

| File | Hook |
|---|---|
| `core.ts` | `...tukSceneFields` in the scene schema; `prepareShots()` at the top of `generate`; the queue runner logs every job with `logJob()`; `flow_download` takes optional `names` |
| `flow.ts` | `runGeneration` names each output from `variant_stems` (disk and Flow title) |
| `index.ts` | `registerTukTools()` adds `flow_mark`, `flow_promote`, `flow_review`, `flow_log` |
| `server.ts` | `tukRoute()` serves the review board under `/tuk/`, behind the Studio token |

## Shot naming

A scene with `shot_id: "EP00_SH012"` and an explicit model is saved as `EP00_SH012_v##_<F|Q|L|O|SF>`, the same name on disk and in Flow (folder-map naming rule). The version is the next free one. Each variant takes its own version. A Quality render reuses the version of the Fast draft it renders.

## Generation log

Every job appends one row per output to `<project folder>/generation-log.csv`. The first 18 columns match the channel's generation-log workbook, so `tuk-generation-log` imports them as they are. Credits are Flow's own quote, split across the outputs, and 0 when the quote was refused before Start. `flow_mark` records Keep, Draft or Reject (with a QC reason) and notes.

## Pre-flight (guard rails, refuses the whole call)

Video shots:
- No banned words (veo-prompt-rules.md).
- A start frame is set.
- The camera line comes first.
- The camera is held static, or there is a `camera_move` with a `last_frame`.
- The prompt says "empty of people".
- An explicit model is set.
- No more than two Fast generations of the same start frame and prompt.
- Quality only from a Fast draft marked Keep, with the same frames and prompt, and once per draft.

Start frames:
- `reference_images` (a Set Bible master) are required.

Warnings (not blocking):
- Burner and lid state.
- Readouts written into the prompt.
- No last frame.
- Gear named in an image prompt.

## Review board

`flow_review` screens each downloaded output with ffmpeg. It takes a thumbnail every 0.5 s and checks for:
- something entering at a frame edge
- the whole frame moving (camera drift or zoom)
- exposure shifts

It also reports the longest clean stretch, and returns a link to the board (`/tuk/review` on the Studio server). On the board you mark each output Keep, Draft or Reject (Reject needs a QC reason) and set the in and out points; the board writes them to the log. The checks were calibrated on TST_SH01_v01_F (an arm entering from frame left at 0.5–2.0 s): they show where to look, and the decision is still yours. Needs ffmpeg on the PATH (or `FLOW_MCP_FFMPEG`).
