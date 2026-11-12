const args = process.argv.slice(2);
function arg(n, d) { const i = args.indexOf("--" + n); return i >= 0 ? args[i + 1] : d; }
const match = arg("match", "");
const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const pages = list.filter(t => t.type === "page" && (!match || t.url.includes(match)));
if (!pages.length) { console.log("NO PAGE"); process.exit(1); }
for (const t of pages.slice(0, 1)) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  const out = [];
  let id = 1;
  const send = (method, params = {}) => ws.send(JSON.stringify({ id: id++, method, params }));
  await new Promise((resolve) => {
    ws.onopen = () => { send("Runtime.enable"); send("Log.enable"); send("Page.enable"); send("Page.reload", { ignoreCache: true }); setTimeout(resolve, 3500); };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === "Runtime.exceptionThrown") out.push("EXC " + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
      if (m.method === "Runtime.consoleAPICalled") out.push(m.params.type.toUpperCase() + " " + m.params.args.map(a => a.value ?? a.description ?? a.type).join(" "));
      if (m.method === "Log.entryAdded") out.push("LOG " + m.params.entry.level + " " + m.params.entry.text);
    };
  });
  const res = await new Promise((resolve) => {
    const w = new WebSocket(t.webSocketDebuggerUrl);
    w.onopen = () => w.send(JSON.stringify({ id: 99, method: "Runtime.evaluate", params: { expression: "JSON.stringify({html: document.body.innerHTML.length, txt: document.body.innerText.slice(0,80), ready: document.readyState})", returnByValue: true, awaitPromise: true } }));
    w.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id === 99) { resolve(m.result?.result?.value); w.close(); } };
    setTimeout(() => resolve("timeout"), 5000);
  });
  console.log("URL", t.url);
  console.log("STATE", res);
  console.log(out.join("\n") || "(no console output)");
  ws.close();
}