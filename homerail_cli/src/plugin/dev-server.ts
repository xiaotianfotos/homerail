import * as http from "node:http";
import { URL } from "node:url";
import {
  testPluginProject,
  validatePluginProject,
  type PluginValidationReport,
} from "./workflows.js";
import type { PluginFixtureMatrixReport } from "homerail-plugin-sdk";

export interface PluginDevReport {
  generated_at: string;
  validation?: PluginValidationReport;
  fixtures?: PluginFixtureMatrixReport;
  error?: string;
}

export interface PluginDevServer {
  server: http.Server;
  url: string;
  close(): Promise<void>;
}

export function inspectPluginDevelopmentProject(root: string, options: { locale?: string } = {}): PluginDevReport {
  try {
    const validation = validatePluginProject(root);
    return {
      generated_at: new Date().toISOString(),
      validation,
      ...(validation.valid ? { fixtures: testPluginProject(root, options) } : {}),
    };
  } catch (cause) {
    return {
      generated_at: new Date().toISOString(),
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

export async function startPluginDevServer(
  root: string,
  options: { host?: string; port?: number } = {},
): Promise<PluginDevServer> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method !== "GET") {
      respondJson(res, 405, { error: "Method not allowed" });
      return;
    }
    if (url.pathname === "/api/report") {
      res.setHeader("Cache-Control", "no-store");
      const locale = url.searchParams.get("locale") ?? undefined;
      if (locale && !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale)) {
        respondJson(res, 400, { error: "Invalid preview locale" });
        return;
      }
      respondJson(res, 200, inspectPluginDevelopmentProject(root, { locale }));
      return;
    }
    if (url.pathname === "/") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(developmentPage());
      return;
    }
    respondJson(res, 404, { error: "Not found" });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Plugin development server did not expose a TCP address");
  }
  return {
    server,
    url: `http://${formatHost(host)}:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((cause) => cause ? reject(cause) : resolve());
    }),
  };
}

function respondJson(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(value));
}

function formatHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function developmentPage(): string {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>HomeRail Plugin Dev</title>
<style>
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#071012;color:#e8fffc}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at top,#123338 0,#071012 48%)}body[data-theme=light]{color-scheme:light;background:#edf8f7;color:#102626}main{max-width:1500px;margin:auto;padding:24px}h1{margin:0;font-size:25px}.lead{color:#9cc8c4}.toolbar{display:flex;flex-wrap:wrap;gap:12px;margin:20px 0;padding:14px;border:1px solid #70ded326;border-radius:16px;background:#0b1a1dcc}.toolbar label{display:grid;gap:5px;color:#9cc8c4;font-size:12px}.toolbar select{min-width:150px;border:1px solid #70ded339;border-radius:9px;background:#071012;color:inherit;padding:8px}.ok{color:#86efac}.bad{color:#fca5a5}.viewports{display:grid;grid-template-columns:minmax(240px,.75fr) minmax(340px,1.15fr) minmax(360px,1.35fr);gap:18px;align-items:start}.viewport{min-width:0;border:1px solid #70ded32b;border-radius:20px;background:#020708b8;padding:12px;box-shadow:0 20px 60px #0005}.viewport h2{margin:0 0 10px;color:#86ddd5;font-size:12px;letter-spacing:.12em;text-transform:uppercase}.viewport[data-device=phone]{max-width:390px}.preview{display:grid;gap:14px;border:1px solid #74e4e329;border-radius:17px;background:linear-gradient(145deg,#122629f5,#070e10fa);padding:16px}.preview header h3,.preview h4,.preview p,.preview ol,.preview ul,.preview dl{margin:0}.preview header h3{font-size:16px}.preview header p{margin-top:5px;color:#d7eeeb9e;font-size:13px}.section{display:grid;gap:7px}.section h4{color:#97ece7bf;font-size:11px;letter-spacing:.08em;text-transform:uppercase}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(85px,1fr));gap:8px}.metrics div,.items li{border-radius:11px;background:#ffffff0a;padding:9px}.metrics dt{color:#dcefea8c;font-size:10px}.metrics dd{margin:3px 0 0;font-size:16px;font-weight:800}.items,.links{display:grid;gap:7px;padding:0;list-style:none}.items li{display:flex;justify-content:space-between;gap:10px}.items strong{font-size:13px}.items p{margin-top:3px;color:#e6f5f394;font-size:12px}.badge{align-self:start;border-radius:999px;background:#74e4e31f;padding:3px 7px;color:#b4f8f4cc;font-size:10px}.links a{color:#89e6e0;font-size:12px}.empty{color:#dcefea73;font-size:12px}.state{margin-top:10px;color:#8fbab6;font:11px ui-monospace,monospace}details{margin-top:22px}pre{white-space:pre-wrap;background:#030708;padding:18px;border-radius:12px;overflow:auto;font:11px ui-monospace,monospace}body[data-theme=light] .toolbar,body[data-theme=light] .viewport{background:#fff}body[data-theme=light] .preview{border-color:#b8dedb;background:#f7ffff;color:#102626}body[data-theme=light] .toolbar select{background:#fff}body[data-theme=light] .preview header p,body[data-theme=light] .items p,body[data-theme=light] .metrics dt,body[data-theme=light] .empty{color:#496b68}body[data-theme=light] .section h4,body[data-theme=light] .viewport h2{color:#167f78}body[data-theme=light] .metrics div,body[data-theme=light] .items li{background:#e8f5f4}body[data-theme=light] .badge{background:#d6efed;color:#176c66}body[data-theme=light] .links a{color:#087a74}body[data-theme=light] .state{color:#537a76}@media(max-width:1000px){.viewports{grid-template-columns:1fr}.viewport[data-device=phone]{max-width:none}}
</style>
<main>
  <h1>HomeRail Plugin Development Browser</h1>
  <p class="lead">The same bounded declarative view model is used here and by Agent UI.</p>
  <p id="status">Loading…</p>
  <div class="toolbar">
    <label>Fixture / state<select id="fixture"></select></label>
    <label>Locale<select id="locale"><option value="en-US">English (US)</option><option value="zh-CN">简体中文</option></select></label>
    <label>Theme<select id="theme"><option value="dark">Dark</option><option value="light">Light</option></select></label>
  </div>
  <div id="viewports" class="viewports"></div>
  <details><summary>Validation and matrix report</summary><pre id="report"></pre></details>
</main>
<script>
const status=document.getElementById('status');const report=document.getElementById('report');const fixtureSelect=document.getElementById('fixture');const localeSelect=document.getElementById('locale');const themeSelect=document.getElementById('theme');const viewports=document.getElementById('viewports');let current;
function element(tag,className,text){const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=String(text);return node}
function sectionNode(section){const root=element('section','section');if(section.label)root.append(element('h4','',section.label));if(section.type==='text'){root.append(element('p','',section.text));return root}if(section.type==='metrics'){const list=element('dl','metrics');for(const item of section.items){const row=element('div');row.append(element('dt','',item.label),element('dd','',item.value));list.append(row)}root.append(list);return root}if(section.type==='list'){const list=element('ol','items');for(const item of section.items){const row=element('li');const copy=element('div');copy.append(element('strong','',item.title));if(item.detail)copy.append(element('p','',item.detail));row.append(copy);if(item.badge)row.append(element('span','badge',item.badge));list.append(row)}root.append(list);return root}const links=element('ul','links');for(const item of section.items){const row=element('li');const link=element('a','',item.label);link.href=item.uri;link.target='_blank';link.rel='noopener noreferrer';row.append(link);links.append(row)}root.append(links);return root}
function previewNode(model,state){const card=element('article','preview');const header=element('header');header.append(element('h3','',model.title));if(model.subtitle)header.append(element('p','',model.subtitle));card.append(header);if(model.sections.length){for(const section of model.sections)card.append(sectionNode(section))}else card.append(element('p','empty',model.empty_message));card.append(element('div','state','fixture state: '+state));return card}
function render(value){current=value;const ok=value.validation&&value.validation.valid&&value.fixtures&&value.fixtures.valid&&!value.error;status.textContent=ok?'Valid — live validation and previews are current':'Needs attention — inspect the report below';status.className=ok?'ok':'bad';report.textContent=JSON.stringify(value,null,2);const fixtures=value.fixtures&&Array.isArray(value.fixtures.fixtures)?value.fixtures.fixtures:[];const selected=fixtureSelect.value;fixtureSelect.replaceChildren();for(const fixture of fixtures){const option=element('option','',fixture.file);option.value=fixture.file;fixtureSelect.append(option)}if(fixtures.some(item=>item.file===selected))fixtureSelect.value=selected;const fixture=fixtures.find(item=>item.file===fixtureSelect.value)||fixtures[0];viewports.replaceChildren();if(!fixture||!fixture.renderer_models||!fixture.renderer_models.length){viewports.append(element('p','bad','No valid declarative renderer preview is available.'));return}const state=fixture.file.replace(/\.json$/,'');const model=fixture.renderer_models[0].model;for(const device of ['phone','desktop','tv']){const shell=element('section','viewport');shell.dataset.device=device;shell.append(element('h2','',device+' viewport'),previewNode(model,state));viewports.append(shell)}}
async function refresh(){try{const url='/api/report?locale='+encodeURIComponent(localeSelect.value);const response=await fetch(url,{cache:'no-store'});const value=await response.json();if(!response.ok)throw new Error(value.error||('HTTP '+response.status));render(value)}catch(error){status.textContent=String(error);status.className='bad'}}
fixtureSelect.addEventListener('change',()=>{if(current)render(current)});localeSelect.addEventListener('change',refresh);themeSelect.addEventListener('change',()=>{document.body.dataset.theme=themeSelect.value});document.body.dataset.theme=themeSelect.value;refresh();setInterval(refresh,1000);
</script>`;
}
