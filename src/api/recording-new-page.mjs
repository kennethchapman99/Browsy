export function renderNewRecordingPage() {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Browsy New Recording</title>
<style>
:root{--ink:#17202a;--muted:#667085;--line:#d0d7e2;--panel:#fff;--bg:#f6f8fb;--accent:#2457d6;--bad:#b42318;--ok:#0f766e;--soft:#eef4ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:1120px;margin:0 auto;padding:28px}.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:22px;margin-bottom:14px}.hero{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}.eyebrow{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--accent);font-weight:900}h1{font-size:30px;line-height:1.12;margin:6px 0 8px}h2{font-size:18px;margin:0 0 8px}.hint{color:var(--muted);font-size:14px;line-height:1.5;margin:0 0 14px}.mini{font-size:12px;color:var(--muted);line-height:1.45}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.table{width:100%;border-collapse:collapse}.table th,.table td{border-bottom:1px solid var(--line);padding:8px;text-align:left;vertical-align:top}.table th{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}.table input[type="checkbox"]{width:auto}.tab-url{min-width:360px}.compact{width:130px}label{display:block;font-size:12px;color:var(--muted);font-weight:850;margin-bottom:5px}input{width:100%;border:1px solid #cbd5e1;border-radius:8px;padding:9px 10px;font:inherit;background:white;color:var(--ink)}button,.button{border:0;border-radius:8px;padding:10px 14px;background:var(--accent);color:white;font:inherit;font-weight:850;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:8px}button.ghost{background:#e7ecf5;color:#1f2937}button.danger{background:#a61b1b}button.small{padding:7px 10px;font-size:12px}button:disabled{opacity:.45;cursor:not-allowed}.row-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.param-row{display:grid;grid-template-columns:220px 1fr auto;gap:8px;margin-bottom:8px}.result{white-space:pre-wrap;font-size:13px;line-height:1.5}.status.ok{color:var(--ok)}.status.bad{color:var(--bad)}.callout{border-left:4px solid var(--accent);background:#f5f8ff;padding:12px 14px;border-radius:6px;margin:12px 0}.badge{display:inline-flex;border-radius:999px;background:var(--soft);color:#173b91;padding:6px 11px;font-size:12px;font-weight:850;white-space:nowrap}
@media(max-width:850px){main{padding:16px}.grid{grid-template-columns:1fr}.tab-url{min-width:0}.param-row{grid-template-columns:1fr}.hero{display:block}}
</style>
</head>
<body>
<main>
  <div class="panel hero" data-testid="new-recording-page">
    <div>
      <div class="eyebrow">Browsy</div>
      <h1>Record a general automation</h1>
      <p class="hint">Create a recording session from Browsy itself. Enter only the starting tabs, auth requirements, and URL parameters. The actual workflow is learned from browser observation.</p>
    </div>
    <span class="badge">/recordings/new</span>
  </div>

  <div class="panel">
    <h2>1. Name it</h2>
    <div class="grid">
      <div><label>App ID</label><input id="appId" data-testid="app-id" value="general-automation"/></div>
      <div><label>App name</label><input id="appName" data-testid="app-name" value="General Automation"/></div>
      <div><label>Workflow ID</label><input id="workflowId" data-testid="workflow-id" value="recorded-workflow"/></div>
      <div><label>Workflow name</label><input id="workflowName" data-testid="workflow-name" value="Recorded Workflow"/></div>
    </div>
  </div>

  <div class="panel">
    <h2>2. URL parameters</h2>
    <p class="hint">Optional. Add values only if your starting tab URLs use templates like <strong>{statementMonth}</strong>, <strong>{accountId}</strong>, or <strong>{{recordId}}</strong>.</p>
    <div id="paramsBody" data-testid="url-params"></div>
    <button type="button" class="ghost small" id="addParamBtn" data-testid="add-param-button">Add Parameter</button>
  </div>

  <div class="panel">
    <h2>3. Starting tabs</h2>
    <p class="hint">Add every page Browsy should open before recording. Mark pages that need a saved/manual auth profile.</p>
    <table class="table" data-testid="tabs-table">
      <thead><tr><th class="compact">ID</th><th>Title</th><th class="tab-url">URL or template</th><th>Site ID</th><th>Needs auth</th><th>Auth profile</th><th></th></tr></thead>
      <tbody id="tabsBody"></tbody>
    </table>
    <div class="row-actions">
      <button type="button" class="ghost small" id="addTabBtn" data-testid="add-tab-button">Add Tab</button>
    </div>
    <div class="callout mini">After creation, the next page lets you open auth profiles, start recording, stop recording, and import the observed workflow.</div>
  </div>

  <div class="panel">
    <button id="createBtn" data-testid="create-recording-button">Create Recording Session</button>
    <div id="result" data-testid="create-result" class="result mini" style="margin-top:12px"></div>
  </div>
</main>
<script>
let tabs=[{id:'target',title:'Target Site',url:'https://example.com',siteId:'target-site',requiresAuth:false,authProfileId:''}];
let params=[];
function el(id){return document.getElementById(id)}
function esc(value){return String(value==null?'':value).replace(/[&<>\"]/g,function(ch){return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[ch]})}
function safeId(value,fallback){return String(value||fallback||'recorded-workflow').trim().toLowerCase().replace(/[^a-z0-9-_]+/g,'-').replace(/^-+|-+$/g,'').slice(0,64)||fallback}
function syncTabs(){tabs=[...document.querySelectorAll('#tabsBody tr')].map(function(row,index){const get=function(f){return row.querySelector('[data-field="'+f+'"]')};return{id:(get('id')?.value||('tab'+(index+1))).trim(),title:(get('title')?.value||'').trim(),url:(get('url')?.value||'').trim(),siteId:(get('siteId')?.value||'').trim(),requiresAuth:!!get('requiresAuth')?.checked,authProfileId:(get('authProfileId')?.value||'').trim()}}).filter(function(tab){return tab.url||tab.title||tab.id})}
function syncParams(){params=[...document.querySelectorAll('[data-param-row]')].map(function(row){return{key:(row.querySelector('[data-param-key]')?.value||'').trim(),value:(row.querySelector('[data-param-value]')?.value||'').trim()}}).filter(function(p){return p.key||p.value})}
function paramsObject(){syncParams();const out={};for(const p of params){if(!p.key)continue;out[p.key]=p.value}return out}
function renderParams(){const body=el('paramsBody');body.innerHTML=params.length?params.map(function(p,i){return '<div class="param-row" data-param-row="'+i+'"><input data-param-key placeholder="parameter name" value="'+esc(p.key)+'"><input data-param-value placeholder="value" value="'+esc(p.value)+'"><button type="button" class="danger small" data-remove-param="'+i+'">Remove</button></div>'}).join(''):'<div class="mini">No URL parameters yet.</div>';body.querySelectorAll('input').forEach(function(input){input.addEventListener('input',syncParams)});body.querySelectorAll('[data-remove-param]').forEach(function(btn){btn.onclick=function(){syncParams();params.splice(Number(btn.dataset.removeParam),1);renderParams()}})}
function renderTabs(){el('tabsBody').innerHTML=tabs.map(function(tab,i){const authProfile=tab.authProfileId||((tab.requiresAuth&&(tab.siteId||tab.id))?safeId(tab.siteId||tab.id,'auth-profile'):'');return '<tr><td><input data-field="id" value="'+esc(tab.id)+'"></td><td><input data-field="title" value="'+esc(tab.title)+'"></td><td><input data-field="url" value="'+esc(tab.url)+'" placeholder="https://... or https://.../{parameter}"></td><td><input data-field="siteId" value="'+esc(tab.siteId)+'"></td><td><label style="margin:0;color:var(--ink);font-size:13px"><input type="checkbox" data-field="requiresAuth" '+(tab.requiresAuth?'checked':'')+'> Required</label></td><td><input data-field="authProfileId" value="'+esc(authProfile)+'" placeholder="profile id"></td><td><button type="button" class="danger small" data-remove-tab="'+i+'">Remove</button></td></tr>'}).join('');el('tabsBody').querySelectorAll('input').forEach(function(input){input.addEventListener('input',syncTabs);input.addEventListener('change',syncTabs)});el('tabsBody').querySelectorAll('[data-remove-tab]').forEach(function(btn){btn.onclick=function(){syncTabs();tabs.splice(Number(btn.dataset.removeTab),1);renderTabs()}})}
function makePayload(){syncTabs();syncParams();const appId=safeId(el('appId').value,'general-automation');const workflowId=safeId(el('workflowId').value,'recorded-workflow');const cleanTabs=tabs.map(function(tab,index){const id=safeId(tab.id,'tab'+(index+1));const url=tab.url.trim();const out={id,title:tab.title||id,url,siteId:safeId(tab.siteId||id,id),requiresAuth:!!tab.requiresAuth};if(/\{\{[^{}]+\}\}|\{[^{}]+\}/.test(url))out.urlTemplate=url;if(tab.authProfileId||tab.requiresAuth)out.authProfileId=safeId(tab.authProfileId||tab.siteId||id,id);return out}).filter(function(tab){return tab.url});if(!cleanTabs.length)throw new Error('Add at least one starting tab URL.');const targetUrl=cleanTabs[0].url;return{appId,appName:el('appName').value.trim()||appId,workflowId,workflowName:el('workflowName').value.trim()||workflowId,targetUrl,recordingSetup:{tabs:cleanTabs},samplePayload:paramsObject(),payloadSchema:{type:'object',additionalProperties:true,properties:{},required:[]},fieldContractIntent:'General Browsy recording created from /recordings/new. Operator supplied only starting tabs, auth requirements, and URL parameters. Browser observation records the workflow.',completionPolicy:{action:'wait_for_human_submission',notes:'Workflow details are captured from browser observation.'}}}
async function createRecording(){el('result').className='result';el('result').textContent='Creating recording session...';try{const payload=makePayload();const res=await fetch('/api/recordings/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const data=await res.json().catch(function(){return{}});if(!res.ok||data.ok===false)throw new Error(data.error||res.statusText);el('result').className='result status ok';el('result').innerHTML='Created. Opening setup page: <a href="'+esc(data.wizardUrl)+'">'+esc(data.wizardUrl)+'</a>';window.location.href=data.wizardUrl}catch(err){el('result').className='result status bad';el('result').textContent='Error: '+(err.message||String(err))}}
el('addParamBtn').onclick=function(){syncParams();params.push({key:'',value:''});renderParams()};
el('addTabBtn').onclick=function(){syncTabs();tabs.push({id:'tab'+(tabs.length+1),title:'',url:'',siteId:'',requiresAuth:false,authProfileId:''});renderTabs()};
el('createBtn').onclick=createRecording;
renderParams();renderTabs();
</script>
</body>
</html>`;
}
