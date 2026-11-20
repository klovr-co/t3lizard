import http from "node:http";
import type { Daemon } from "./daemon.ts";

/**
 * A read-only page with the pool at a glance: vCPU in use, machines, queue, spend, learned sizes and
 * recent jobs. Served on 127.0.0.1 and the publicBind addresses (the devbox's Tailscale IP). It shows
 * no secrets: no tokens, access tokens or pairing links are in the data.
 */
export async function startDashboard(daemon: Daemon, port: number, hosts: string[], log: (l: string) => void): Promise<http.Server[]> {
  if (!port) return [];
  const handler: http.RequestListener = (req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method !== "GET") {
      res.writeHead(405).end();
      return;
    }
    if (path === "/data.json") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(daemon.dashboard()));
      return;
    }
    if (path === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(PAGE);
      return;
    }
    res.writeHead(404).end();
  };
  const servers: http.Server[] = [];
  for (const host of ["127.0.0.1", ...hosts]) {
    const s = http.createServer(handler);
    await new Promise<void>((resolve) => {
      s.once("error", (e) => {
        log(`dashboard on ${host}:${port} did not start: ${e.message}`);
        resolve();
      });
      s.listen(port, host, () => {
        log(`dashboard on http://${host}:${port}/`);
        servers.push(s);
        resolve();
      });
    });
  }
  return servers;
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>t3lizard pool</title>
<style>
:root{--bg:#fbfbfa;--card:#fff;--ink:#1d1d1b;--muted:#6b6b66;--line:#e6e5e1;--accent:#2f6f4f;--warn:#a5521b;--bad:#b42318;--bar:#e9efe9}
@media (prefers-color-scheme:dark){:root{--bg:#151514;--card:#1d1d1b;--ink:#ecece8;--muted:#9a9a93;--line:#2c2c29;--accent:#7cc39b;--warn:#e3a06b;--bad:#f07a6e;--bar:#25332b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1100px;margin:0 auto;padding:20px 16px 48px}h1{font-size:20px;margin:0 0 2px}h2{font-size:14px;margin:28px 0 8px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.sub{color:var(--muted);font-size:13px}.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin-top:16px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}.tile .k{color:var(--muted);font-size:12px}.tile .v{font-size:24px;font-weight:650;margin-top:2px;font-variant-numeric:tabular-nums}
.bar{height:6px;background:var(--bar);border-radius:3px;margin-top:8px;overflow:hidden}.bar i{display:block;height:100%;background:var(--accent)}
.wrap{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:10px}table{border-collapse:collapse;width:100%;min-width:640px}
th,td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--line);white-space:nowrap;font-variant-numeric:tabular-nums}th{color:var(--muted);font-weight:600;font-size:12px}tr:last-child td{border-bottom:0}
td.wrapcell{white-space:normal;min-width:220px}.pill{display:inline-block;padding:1px 8px;border-radius:999px;border:1px solid var(--line);font-size:12px}
.bad{color:var(--bad)}.warn{color:var(--warn)}.ok{color:var(--accent)}.empty{padding:14px;color:var(--muted)}
</style></head><body><main>
<h1>t3lizard pool</h1><div class="sub" id="sub">loading…</div>
<div class="tiles" id="tiles"></div>
<h2>Machines</h2><div class="wrap"><table id="machines"></table></div>
<h2>Queue</h2><div class="wrap"><table id="queue"></table></div>
<h2>Per repo (learned)</h2><div class="wrap"><table id="learned"></table></div>
<h2>Recent jobs</h2><div class="wrap"><table id="jobs"></table></div>
<h2>Spend by day (UTC)</h2><div class="wrap"><table id="days"></table></div>
</main><script>
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const usd=n=>"$"+(n<1?n.toFixed(3):n.toFixed(2));const min=ms=>ms<60000?Math.round(ms/1000)+"s":Math.round(ms/60000)+" min";
const repo=r=>esc(r.replace(/^github\\.com\\//,""));const ago=t=>{const m=Math.round((Date.now()-t)/60000);return m<1?"now":m<60?m+" min ago":Math.round(m/60)+" h ago"};
function table(id,head,rows,empty){const t=document.getElementById(id);t.innerHTML=rows.length?"<tr>"+head.map(h=>"<th>"+h+"</th>").join("")+"</tr>"+rows.map(r=>"<tr>"+r.map(c=>"<td"+(String(c).length>60?' class="wrapcell"':"")+">"+c+"</td>").join("")+"</tr>").join(""):"<tr><td class='empty'>"+empty+"</td></tr>"}
async function load(){let d;try{d=await (await fetch("data.json",{cache:"no-store"})).json()}catch(e){document.getElementById("sub").textContent="daemon not answering";return}
const s=d.status,v=d.vcpu;const pools=Object.entries(s.pools);const machines=pools.flatMap(([r,p])=>p.machines.map(m=>({...m,repo:r,lease:p.leases.find(l=>l.machineId===m.id)})));
const queue=pools.flatMap(([r,p])=>p.queue.map(q=>({...q,repo:r})));
document.getElementById("sub").textContent="updated "+new Date(d.now).toLocaleTimeString()+" · refreshes every 10 s";
const pct=v.limit?Math.min(100,Math.round(v.inUse/v.limit*100)):0;
document.getElementById("tiles").innerHTML=[
["vCPU in use",v.inUse+(v.limit?" / "+v.limit:""),v.limit?'<div class="bar"><i style="width:'+pct+'%"></i></div>':""],
["Machines",machines.length,""],["Waiting",queue.length,queue.length?'<div class="sub">longest '+Math.max(...queue.map(q=>q.waitedMinutes))+' min</div>':""],
["Spend today",usd(d.spend.today),""],["Spend this month",usd(d.spend.thisMonth),'<div class="sub">Pro includes $19</div>']
].map(([k,val,x])=>'<div class="tile"><div class="k">'+k+'</div><div class="v">'+val+'</div>'+x+'</div>').join("");
table("machines",["Machine","Repo","Size","Phase","Holder","Age","Ends in"],machines.map(m=>[esc(m.id),repo(m.repo),'<span class="pill">'+esc(m.size)+'</span>',
(m.notAnswering?'<span class="bad">not answering</span>':m.phase==="failed"?'<span class="bad">failed</span>':esc(m.phase)),esc(m.lease?.holder??""),m.ageMinutes+" min",m.deadlineInMinutes+" min"]),"No machines running.");
table("queue",["Repo","Holder","Waited","Why"],queue.map(q=>[repo(q.repo),esc(q.holder),q.waitedMinutes+" min",esc(q.reason??"")]),"Nobody waiting.");
table("learned",["Repo","Next machines","Never below","Why this size","Keep idle","Why","Jobs","Reused"],d.learned.map(l=>[repo(l.repo),'<span class="pill">'+esc(l.size)+'</span>',esc(l.minSize??"—"),esc(l.why),l.keepIdleMinutes+" min",esc(l.idleWhy),l.jobs,l.reusePct==null?"—":l.reusePct+"%"]),"Nothing learned yet.");
table("jobs",["Ended","Repo","Holder","Size","Waited","Ran","Peak memory","Result"],d.jobs.map(j=>[ago(j.endedAt),repo(j.repo),esc(j.holder),esc(j.size),min(j.waitedMs),min(j.endedAt-j.grantedAt),
j.peakMemPct==null?"—":'<span class="'+(j.peakMemPct>=85?"bad":j.peakMemPct<40?"ok":"")+'">'+j.peakMemPct+'%</span>',
j.froze?'<span class="bad">froze</span>':j.memKills?'<span class="warn">'+j.memKills+' killed for memory</span>':'<span class="ok">ok</span>']),"No jobs recorded yet.");
table("days",["Day","Spend"],d.spend.byDay.map(x=>[esc(x.day),usd(x.usd)]),"No usage yet.")}
load();setInterval(load,10000);
</script></body></html>`;
