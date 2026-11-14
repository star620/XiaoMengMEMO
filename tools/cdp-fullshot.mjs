import fs from "node:fs";
const args = process.argv.slice(2);
function arg(n, d){ const i = args.indexOf("--"+n); return i>=0 ? args[i+1] : d; }
const match = arg("match","");
const out = arg("out","");
const width = Number(arg("width","480"));
const height = Number(arg("height","960"));
const scale = Number(arg("scale","1.5"));
const wait = Number(arg("wait","600"));
const ev = arg("eval","");
const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const pages = list.filter(t => t.type == "page" && (!match || t.url.includes(match)));
if (!pages.length) { console.log("NO PAGE"); process.exit(1); }
const t = pages[0];
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
function call(method, params){ const myId = ++id; ws.send(JSON.stringify({id:myId,method,params})); return new Promise((res,rej)=>pending.set(myId,{res,rej})); }
ws.onmessage = e => { const m = JSON.parse(e.data); const p = pending.get(m.id); if(!p) return; pending.delete(m.id); if(m.error) p.rej(new Error(JSON.stringify(m.error))); else p.res(m.result); };
await new Promise((res,rej)=>{ ws.onopen = res; ws.onerror = ()=>rej(new Error("ws error")); });
await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false });
if (ev) { const r = await call("Runtime.evaluate", { expression: ev, awaitPromise: true, returnByValue: true }); console.log("EVAL => " + JSON.stringify(r.result && r.result.value)); }
await new Promise(r=>setTimeout(r, wait));
const metrics = await call("Runtime.evaluate", { expression: "JSON.stringify({inner:[innerWidth,innerHeight],scroll:[document.documentElement.scrollWidth,document.documentElement.scrollHeight]})", returnByValue: true });
console.log("METRICS => " + (metrics.result && metrics.result.value));
const shot = await call("Page.captureScreenshot", { format:"png", fromSurface:true });
fs.writeFileSync(out, Buffer.from(shot.data,"base64"));
console.log("SHOT " + out + " " + fs.statSync(out).size + " bytes");
await call("Emulation.clearDeviceMetricsOverride");
ws.close();
