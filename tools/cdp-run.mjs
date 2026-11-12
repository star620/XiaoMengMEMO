import fs from "node:fs";
const args = process.argv.slice(2);
function arg(name, def) { const i = args.indexOf("--" + name); return i >= 0 ? args[i + 1] : def; }
const exprFile = arg("expr");
const match = arg("match", "");
const expr = fs.readFileSync(exprFile, "utf8");
const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
let pages = list.filter(t => t.type === "page" && (!match || t.url.includes(match)));
if (args.includes("--first")) pages = pages.slice(0, 1);
function evalOn(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("timeout")); }, 20000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
    ws.onmessage = (ev) => { const msg = JSON.parse(ev.data); if (msg.id !== 1) return; clearTimeout(timer); ws.close(); if (msg.result && msg.result.exceptionDetails) { resolve("EXC " + JSON.stringify(msg.result.exceptionDetails.exception && msg.result.exceptionDetails.exception.description || msg.result.exceptionDetails.text)); return; } resolve(msg.result && msg.result.result ? msg.result.result.value : null); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("ws error")); };
  });
}
if (!pages.length) { console.log("NO PAGE for match=" + match); process.exit(1); }
for (const t of pages) {
  let v;
  try { v = await evalOn(t.webSocketDebuggerUrl, expr); } catch (e) { v = "ERR " + e.message; }
  console.log((t.url.split("?surface=")[1] || t.url) + " => " + v);
}