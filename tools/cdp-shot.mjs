import fs from "node:fs";
const args = process.argv.slice(2);
function arg(name, def) { const i = args.indexOf("--" + name); return i >= 0 ? args[i + 1] : def; }
const match = arg("match", "");
const out = arg("out", "");
const evFile = arg("eval-file", "");
const ev = evFile ? fs.readFileSync(evFile, "utf8") : arg("eval", "");
const wait = Number(arg("wait", "450"));
const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const pages = list.filter(t => t.type === "page" && (!match || t.url.includes(match)));
if (!pages.length) { console.log("NO PAGE"); process.exit(1); }
const t = pages[0];
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
function call(method, params) { const myId = ++id; ws.send(JSON.stringify({ id: myId, method, params })); return new Promise((res, rej) => pending.set(myId, { res, rej })); }
ws.onmessage = ev2 => { const m = JSON.parse(ev2.data); const p = pending.get(m.id); if (!p) return; pending.delete(m.id); if (m.error) p.rej(new Error(JSON.stringify(m.error))); else p.res(m.result); };
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws error")); });
if (ev) {
  const r = await call("Runtime.evaluate", { expression: ev, awaitPromise: true, returnByValue: true });
  console.log("EVAL => " + JSON.stringify(r.result && r.result.value));
}
await new Promise(r => setTimeout(r, wait));
const shot = await call("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: args.includes("--beyond") });
fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
console.log("SHOT " + out + " " + fs.statSync(out).size + " bytes");
ws.close();