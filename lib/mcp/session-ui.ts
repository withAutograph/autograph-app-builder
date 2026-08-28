import packageManifest from "../../package.json";

export const MCP_APP_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
export const APP_VERSION = packageManifest.version;
const prototypeDocumentCsp =
  "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; base-uri 'none'; connect-src 'none'; form-action 'none'; frame-src 'none'; img-src data:; media-src data:; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'\">";
const prototypeDocumentPrefix = `<!doctype html><html><head>${prototypeDocumentCsp}<meta charset="utf-8"></head><body>`;
const prototypeDocumentSuffix = "</body></html>";

export function sandboxedPrototypeDocument(html: string): string {
  return `${prototypeDocumentPrefix}${html}${prototypeDocumentSuffix}`;
}

export const sessionUiHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Autograph App Builder</title>
  <style>
    :root{color-scheme:light dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--bg:var(--color-background-primary,#fff);--surface:var(--color-background-secondary,#f7f7f5);--text:var(--color-text-primary,#1d1d1f);--muted:var(--color-text-secondary,#686866);--line:var(--color-border-secondary,rgba(28,28,26,.12));--accent:var(--color-accent-primary,#6c4df6);--danger:#c63c3c}
    *{box-sizing:border-box}
    html,body{height:312px;min-height:312px;max-height:312px;margin:0;overflow:hidden;background:transparent;color:var(--text)}
    body{padding:8px;font-size:13px;line-height:1.45}
    .shell{height:296px;display:grid;grid-template-rows:auto minmax(0,1fr) auto;overflow:hidden;border:1px solid var(--line);border-radius:14px;background:var(--bg);box-shadow:0 1px 2px rgba(20,20,18,.04)}
    header{display:flex;align-items:center;gap:10px;padding:13px 14px 11px;border-bottom:1px solid var(--line)}
    .mark{display:grid;place-items:center;width:28px;height:28px;border-radius:9px;color:#fff;background:linear-gradient(145deg,#8069ff,#5738df);box-shadow:0 4px 12px rgba(92,61,225,.22);font-weight:700;font-size:14px}
    .title{min-width:0;flex:1}.title strong{display:block;font-size:14px;letter-spacing:-.01em}.title span{display:block;color:var(--muted);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .state{display:flex;align-items:center;gap:6px;color:var(--muted);font-size:12px}
    .dot{width:7px;height:7px;border-radius:999px;background:#8b8b88}.working .dot,.waiting .dot{background:var(--accent)}.completed .dot{background:#28885c}.failed .dot{background:var(--danger)}.cancelled .dot{background:#8b8b88}
    .working .dot{animation:pulse 1.8s ease-in-out infinite}
    main{min-height:0;overflow:auto;padding:8px 14px 12px;scrollbar-width:thin;overscroll-behavior:contain}
    main.prototype-ready{overflow:hidden;padding:0}
    .prototype{width:100%;height:100%;background:#fff}.prototype iframe{display:block;width:100%;height:100%;border:0;background:#fff}
    .progress{height:100%}
    .empty{height:100%;display:grid;place-content:center;text-align:center;color:var(--muted);gap:7px}.empty strong{color:var(--text);font-weight:600}
    .events{display:grid;gap:2px}.event{display:grid;grid-template-columns:18px minmax(0,1fr);gap:8px;padding:7px 0;border-bottom:1px solid color-mix(in srgb,var(--line) 65%,transparent)}.event:last-child{border-bottom:0}
    .event-icon{display:grid;place-items:center;width:18px;height:18px;margin-top:1px;border-radius:6px;background:var(--surface);color:var(--muted);font-size:10px;font-weight:700}
    .event-copy{min-width:0;white-space:pre-wrap;overflow-wrap:anywhere}.event-copy small{display:block;color:var(--muted);font-size:11px;margin-bottom:1px}.event.error .event-copy{color:var(--danger)}
    footer{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 14px;border-top:1px solid var(--line);background:color-mix(in srgb,var(--surface) 55%,var(--bg));color:var(--muted);font-size:11px}.count{font-variant-numeric:tabular-nums}
    @keyframes pulse{0%,100%{opacity:.45;transform:scale(.8)}50%{opacity:1;transform:scale(1)}}
    @media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}.working .dot{animation:none}}
    @media(prefers-color-scheme:dark){:root{--bg:#181817;--surface:#232321;--text:#f2f2ef;--muted:#a4a49e;--line:rgba(255,255,255,.12);--accent:#9d8aff}.shell{box-shadow:none}}
  </style>
</head>
<body>
  <section class="shell" aria-label="Autograph App Builder progress">
    <header><div class="mark" aria-hidden="true">A</div><div class="title"><strong>Autograph App Builder</strong><span id="subtitle">App build</span></div><div class="state working" id="state"><span class="dot"></span><span id="state-label">Connecting</span></div></header>
    <main id="content"><div class="prototype" id="prototype" hidden></div><div class="progress" id="progress"><div class="empty" id="empty"><strong>Connecting to Autograph App Builder</strong><span>Build updates will appear here.</span></div><div class="events" id="events" hidden></div></div></main>
    <footer><span id="summary">Waiting for the first update</span><span class="count" id="count">0 events</span></footer>
  </section>
  <script>
    (()=>{
      const protocolVersion="2026-01-26";
      const events=new Map();
      const content=document.getElementById("content");
      const prototype=document.getElementById("prototype");
      const progress=document.getElementById("progress");
      const eventList=document.getElementById("events");
      const empty=document.getElementById("empty");
      const state=document.getElementById("state");
      const stateLabel=document.getElementById("state-label");
      const summary=document.getElementById("summary");
      const count=document.getElementById("count");
      const labels={working:"Working",input_required:"Needs input",waiting:"Waiting",completed:"Complete",failed:"Failed",cancelled:"Cancelled"};
      const icons={assistant_message:"E",progress:"·",input_required:"?",status:"·",error:"!"};
      const prototypeDocumentPrefix=${JSON.stringify(prototypeDocumentPrefix)};
      const prototypeDocumentSuffix=${JSON.stringify(prototypeDocumentSuffix)};
      function text(value){return typeof value==="string"?value:""}
      function prototypeDocument(html){
        return prototypeDocumentPrefix+html+prototypeDocumentSuffix;
      }
      function renderPrototype(value){
        if(!value||value.mediaType!=="text/html"||typeof value.content!=="string"||typeof value.digest!=="string"){
          prototype.hidden=true;progress.hidden=false;content.classList.remove("prototype-ready");return;
        }
        if(prototype.dataset.digest!==value.digest){
          const frame=document.createElement("iframe");
          frame.title="Interactive app prototype";
          frame.setAttribute("sandbox","allow-scripts");
          frame.setAttribute("referrerpolicy","no-referrer");
          frame.srcdoc=prototypeDocument(value.content);
          prototype.replaceChildren(frame);prototype.dataset.digest=value.digest;
        }
        prototype.hidden=false;progress.hidden=true;content.classList.add("prototype-ready");
      }
      function renderEvent(event){
        const row=document.createElement("div");row.className="event "+(event.type==="error"?"error":"");row.dataset.index=String(event.index);
        const icon=document.createElement("span");icon.className="event-icon";icon.textContent=icons[event.type]||"·";
        const copy=document.createElement("div");copy.className="event-copy";
        const label=document.createElement("small");
        let body="";
        if(event.type==="assistant_message"){label.textContent="Autograph App Builder";body=text(event.text)}
        else if(event.type==="progress"){label.textContent=event.state==="completed"?"Completed":event.state==="failed"?"Failed":"In progress";body=text(event.label)}
        else if(event.type==="input_required"){label.textContent="Input requested";body=text(event.request&&event.request.title)}
        else if(event.type==="error"){label.textContent=text(event.code)||"Error";body=text(event.message)}
        else{label.textContent="Status";body=labels[event.status]||text(event.status)}
        copy.append(label,document.createTextNode(body));row.append(icon,copy);return row;
      }
      function update(result){
        if(!result||typeof result!=="object")return;
        renderPrototype(result.prototype);
        for(const event of Array.isArray(result.events)?result.events:[]){if(Number.isInteger(event.index))events.set(event.index,event)}
        const ordered=[...events.values()].sort((a,b)=>a.index-b.index);
        eventList.replaceChildren(...ordered.map(renderEvent));eventList.hidden=ordered.length===0;empty.hidden=ordered.length!==0;
        const status=labels[result.status]?result.status:"working";state.className="state "+status;stateLabel.textContent=labels[status];
        summary.textContent=status==="input_required"?"Autograph App Builder is waiting for your response":status==="completed"?"App build finished":status==="failed"?text(result.error&&result.error.message)||"App build failed":status==="cancelled"?"App build cancelled":"Autograph App Builder is working";
        count.textContent=ordered.length+" event"+(ordered.length===1?"":"s");
        requestAnimationFrame(()=>{if(!progress.hidden)content.scrollTop=content.scrollHeight});
      }
      window.addEventListener("message",event=>{
        if(event.source!==window.parent)return;
        const message=event.data;
        if(!message||message.jsonrpc!=="2.0")return;
        if(message.id==="eve-session-init"){
          window.parent.postMessage({jsonrpc:"2.0",method:"ui/notifications/initialized"},"*");
          return;
        }
        if(message.method==="ui/notifications/tool-result")update(message.params&&message.params.structuredContent);
      });
      window.parent.postMessage({jsonrpc:"2.0",id:"eve-session-init",method:"ui/initialize",params:{protocolVersion,appInfo:{name:"Autograph App Builder",version:"${APP_VERSION}"},appCapabilities:{}}},"*");
    })();
  </script>
</body>
</html>`;
