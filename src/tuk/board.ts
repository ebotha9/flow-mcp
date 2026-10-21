// TUK review board, served by the Studio server on 127.0.0.1 behind its per-run token:
//   GET  /tuk/review?project=X   the page
//   GET  /tuk/data?project=X     outputs to review, with analysis (all=1 includes reviewed ones)
//   GET  /tuk/ref?project=X&stem=S&i=N   reference image N of a logged still (references live outside the films folder)
//   POST /tuk/mark               { project, marks } as flow_mark
import { createReadStream, existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname } from "node:path";
import { projectDir } from "../core.js";
import { REJECT_REASONS } from "./fields.js";
import { readLog } from "./log.js";
import { analyseProject } from "./review.js";
import { markDrafts, tukShapes } from "./tools.js";
import { z } from "zod";

const send = (res: ServerResponse, code: number, type: string, body: string) => {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
};
const json = (res: ServerResponse, code: number, data: unknown) => send(res, code, "application/json", JSON.stringify(data));

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1024 * 1024) throw new Error("Body too large.");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString() || "{}";
}

export async function tukRoute(req: IncomingMessage, res: ServerResponse, url: URL, token: string): Promise<boolean> {
  if (!url.pathname.startsWith("/tuk/")) return false;
  try {
    const project = url.searchParams.get("project") ?? "";
    if (req.method === "GET" && url.pathname === "/tuk/review") {
      send(res, 200, "text/html; charset=utf-8", page(project, token));
      return true;
    }
    if (req.method === "GET" && url.pathname === "/tuk/data") {
      const dir = projectDir(project);
      const rows = readLog(dir);
      const items = await analyseProject(dir, undefined, url.searchParams.get("all") !== "1");
      json(
        res,
        200,
        items.map((a) => {
          const r = [...rows].reverse().find((x) => x.Stem === a.stem && x.Status === "done")!;
          return {
            ...a,
            dir: `${dir}`,
            model: r.Model,
            credits: r.Credits,
            prompt: r["Prompt as written"],
            start_frame: r["Start frame"],
            refs: r["Reference images"] ? r["Reference images"].split(" | ").length : 0,
            reason: r["Reject reason"],
            notes: r.Notes,
            in_s: r["In (s)"],
            out_s: r["Out (s)"],
          };
        }),
      );
      return true;
    }
    if (req.method === "GET" && url.pathname === "/tuk/ref") {
      const row = readLog(projectDir(project)).find((r) => r.Stem === url.searchParams.get("stem"));
      const file = row?.["Reference images"].split(" | ")[Number(url.searchParams.get("i") ?? 0)];
      if (!file || file.startsWith("asset:") || !existsSync(file) || !/\.(jpe?g|png|webp)$/i.test(file)) {
        json(res, 404, { error: "Not found." });
        return true;
      }
      res.writeHead(200, { "content-type": extname(file).toLowerCase() === ".png" ? "image/png" : extname(file).toLowerCase() === ".webp" ? "image/webp" : "image/jpeg" });
      createReadStream(file).pipe(res);
      return true;
    }
    if (req.method === "POST" && url.pathname === "/tuk/mark") {
      const args = z.object(tukShapes.mark).parse(JSON.parse(await body(req)));
      json(res, 200, markDrafts(args));
      return true;
    }
    json(res, 404, { error: "Not found." });
  } catch (err) {
    json(res, 400, { error: err instanceof z.ZodError ? err.issues.map((i) => i.message).join("; ") : err instanceof Error ? err.message : String(err) });
  }
  return true;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(project: string, token: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Review · ${esc(project)}</title>
<style>
:root{--bg:#141414;--card:#1e1e1e;--line:#2e2e2e;--text:#e8e6e1;--muted:#9a978f;--keep:#4caf7a;--reject:#e0624f;--draft:#c9a24a;--accent:#7aa7e0}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
header{position:sticky;top:0;z-index:2;background:var(--bg);border-bottom:1px solid var(--line);padding:12px 20px;display:flex;gap:16px;align-items:center;flex-wrap:wrap}
h1{font-size:16px;margin:0;font-weight:600}header .count{color:var(--muted)}label.toggle{margin-left:auto;color:var(--muted)}
main{padding:16px 20px;display:grid;gap:16px;max-width:1400px;margin:0 auto}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px;display:grid;gap:10px}
.card.done-Keep{border-color:var(--keep)}.card.done-Reject{border-color:var(--reject)}
.top{display:flex;gap:12px;align-items:baseline;flex-wrap:wrap}.stem{font-weight:600;font-size:15px;font-family:ui-monospace,Consolas,monospace}
.meta{color:var(--muted)}.badge{padding:1px 8px;border-radius:10px;font-size:12px;background:var(--line)}
.badge.Keep{background:var(--keep);color:#111}.badge.Reject{background:var(--reject);color:#111}.badge.Draft{background:var(--draft);color:#111}
.flags{margin:0;padding-left:18px;color:#f0b8a8}.flags li.ok{color:var(--keep);list-style:none;margin-left:-18px}
.media{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);gap:12px}@media(max-width:900px){.media{grid-template-columns:1fr}}
video,.still{width:100%;border-radius:6px;background:#000;display:block}
.thumbs{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;align-content:start}
.thumb{position:relative;cursor:pointer;border:2px solid transparent;border-radius:4px;overflow:hidden}
.thumb img{width:100%;display:block}.thumb span{position:absolute;left:3px;bottom:2px;font-size:11px;background:#000a;padding:0 4px;border-radius:3px}
.thumb.flag{border-color:var(--reject)}.thumb.clean{border-color:var(--keep)}
.refs{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:6px}.refs img{width:100%;border-radius:4px}
details{color:var(--muted)}details p{white-space:pre-wrap;margin:6px 0 0;color:var(--text)}
.controls{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
button,select,input{background:#262626;color:var(--text);border:1px solid var(--line);border-radius:6px;padding:6px 10px;font:inherit}
button{cursor:pointer}button:hover{border-color:var(--muted)}button.k{border-color:var(--keep)}button.r{border-color:var(--reject)}button.d{border-color:var(--draft)}
button.on.k{background:var(--keep);color:#111}button.on.r{background:var(--reject);color:#111}button.on.d{background:var(--draft);color:#111}
input.num{width:70px}input.notes{flex:1;min-width:220px}.saved{color:var(--keep)}.err{color:var(--reject)}
.empty{color:var(--muted);padding:40px;text-align:center}
</style></head><body>
<header><h1>Review · ${esc(project)}</h1><span class="count" id="count"></span>
<label class="toggle"><input type="checkbox" id="all"> show reviewed</label></header>
<main id="list"><p class="empty">Analysing clips…</p></main>
<script>
const TOKEN=${JSON.stringify(token)}, PROJECT=${JSON.stringify(project)}, REASONS=${JSON.stringify(REJECT_REASONS)};
const media=p=>'/media?token='+encodeURIComponent(TOKEN)+'&path='+encodeURIComponent(p);
const h=(t,a={},...k)=>{const e=document.createElement(t);for(const[n,v]of Object.entries(a)){if(n==='on')for(const[ev,f]of Object.entries(v))e.addEventListener(ev,f);else if(v!==undefined&&v!==false)e.setAttribute(n,v===true?'':v)}for(const c of k.flat())if(c!=null)e.append(c);return e};
function flagged(it,t){return it.flags.some(f=>t>=f.from&&t<=f.to)}
function clean(it,t){return it.clean_window&&t>=it.clean_window.from&&t<=it.clean_window.to}
function card(it){
  const c=h('section',{class:'card'+(it.outcome?' done-'+it.outcome:'')});
  let outcome=it.outcome||'';const status=h('span',{class:'badge '+outcome},outcome||'unreviewed');
  c.append(h('div',{class:'top'},h('span',{class:'stem'},it.stem),h('span',{class:'meta'},it.model+' · '+it.credits+' cr'+(it.start_frame?' · from '+it.start_frame:'')),status));
  const fl=h('ul',{class:'flags'});
  if(it.kind==='video'){if(!it.flags.length)fl.append(h('li',{class:'ok'},'No edge entries, drift or exposure shifts detected.'));
    for(const f of it.flags)fl.append(h('li',{},f.kind==='edge'?'Change at the '+f.where+' edge '+f.from+'–'+f.to+' s: a hand or person entering?':f.kind==='local'?'Large local change '+f.from+'–'+f.to+' s: the intended action, or something appearing?':f.kind==='drift'?'Whole frame moves '+f.from+'–'+f.to+' s: camera drift or zoom':'Exposure shift '+f.from+'–'+f.to+' s'));
    if(it.clean_window)fl.append(h('li',{class:'ok'},'Clean stretch '+it.clean_window.from+'–'+it.clean_window.to+' s.'))}
  c.append(fl);
  let player;
  if(it.kind==='video'){player=h('video',{src:media(it.file),controls:true,preload:'metadata',muted:true});
    const th=h('div',{class:'thumbs'});it.thumbs.forEach((f,i)=>{const t=i/2;th.append(h('div',{class:'thumb'+(flagged(it,t)?' flag':clean(it,t)?' clean':''),title:t+' s',on:{click:()=>{player.currentTime=t;player.pause()}}},h('img',{src:media(it.dir+'/review/'+f),loading:'lazy'}),h('span',{},t.toFixed(1)+' s')))});
    c.append(h('div',{class:'media'},player,th))}
  else{const refs=h('div',{class:'refs'});for(let i=0;i<it.refs;i++)refs.append(h('img',{src:'/tuk/ref?token='+encodeURIComponent(TOKEN)+'&project='+encodeURIComponent(PROJECT)+'&stem='+encodeURIComponent(it.stem)+'&i='+i,title:'reference '+(i+1)}));
    c.append(h('div',{class:'media'},h('img',{class:'still',src:media(it.file)}),h('div',{},h('div',{class:'meta'},'References'),refs)))}
  c.append(h('details',{},h('summary',{},'Prompt'),h('p',{},it.prompt)));
  const reason=h('select',{},h('option',{value:''},'reason…'),...REASONS.map(r=>h('option',{value:r,selected:r===it.reason},r)));
  const inS=h('input',{class:'num',type:'number',step:'0.25',min:'0',placeholder:'in',value:it.in_s||(it.clean_window?it.clean_window.from:'')});
  const outS=h('input',{class:'num',type:'number',step:'0.25',min:'0',placeholder:'out',value:it.out_s||(it.clean_window?it.clean_window.to:'')});
  const notes=h('input',{class:'notes',placeholder:'notes: what to change next time, or why it is a keeper'});
  const msg=h('span',{});
  const btn=(label,cls)=>{const b=h('button',{class:cls+(outcome===label?' on':''),on:{click:()=>{outcome=label;for(const x of bs)x.classList.toggle('on',x===b)}}},label);return b};
  const bs=[btn('Keep','k'),btn('Draft','d'),btn('Reject','r')];
  const save=h('button',{on:{click:async()=>{
    if(!outcome){msg.className='err';msg.textContent='Pick Keep, Draft or Reject.';return}
    if(outcome==='Reject'&&!reason.value){msg.className='err';msg.textContent='A Reject needs a reason.';return}
    const m={stem:it.stem,outcome};if(outcome==='Reject')m.reason=reason.value;if(notes.value.trim())m.notes=notes.value.trim();
    if(it.kind==='video'&&inS.value!=='')m.in_s=Number(inS.value);if(it.kind==='video'&&outS.value!=='')m.out_s=Number(outS.value);
    const r=await fetch('/tuk/mark?token='+encodeURIComponent(TOKEN),{method:'POST',headers:{'content-type':'application/json','x-flow-token':TOKEN},body:JSON.stringify({project:PROJECT,marks:[m]})});
    const d=await r.json();if(!r.ok){msg.className='err';msg.textContent=d.error;return}
    msg.className='saved';msg.textContent='Saved';status.className='badge '+outcome;status.textContent=outcome;c.className='card done-'+outcome;notes.value=''}}},'Save');
  const ctl=h('div',{class:'controls'},...bs,reason);
  if(it.kind==='video')ctl.append(h('button',{on:{click:()=>inS.value=player.currentTime.toFixed(2)}},'In = now'),inS,h('button',{on:{click:()=>outS.value=player.currentTime.toFixed(2)}},'Out = now'),outS);
  ctl.append(notes,save,msg);c.append(ctl);return c}
async function load(){const list=document.getElementById('list');list.innerHTML='<p class="empty">Analysing clips…</p>';
  const r=await fetch('/tuk/data?token='+encodeURIComponent(TOKEN)+'&project='+encodeURIComponent(PROJECT)+(document.getElementById('all').checked?'&all=1':''));
  const d=await r.json();list.innerHTML='';if(!r.ok){list.append(h('p',{class:'empty err'},d.error));return}
  document.getElementById('count').textContent=d.length+' output'+(d.length===1?'':'s');
  if(!d.length)list.append(h('p',{class:'empty'},'Nothing left to review.'));for(const it of d)list.append(card(it))}
document.getElementById('all').addEventListener('change',load);load();
</script></body></html>`;
}
