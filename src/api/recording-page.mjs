export function renderEditableRecordingPage(recordingSessionId) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Browsy Record Automation</title>
<style>
:root{--ink:#17202a;--muted:#667085;--line:#d0d7e2;--panel:#fff;--bg:#f6f8fb;--accent:#2457d6;--ok:#0f766e;--warn:#b45309;--bad:#b42318;--soft:#eef4ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:1180px;margin:0 auto;padding:24px}.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:20px;margin-bottom:14px}.hero{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}.eyebrow{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--accent);font-weight:900}h1{font-size:27px;line-height:1.15;margin:6px 0 8px}h2{font-size:18px;margin:0 0 8px}.hint{color:var(--muted);font-size:14px;line-height:1.5;margin:0 0 14px}.mini{font-size:12px;color:var(--muted);line-height:1.45}.badge{display:inline-flex;border-radius:999px;background:var(--soft);color:#173b91;padding:6px 11px;font-size:12px;font-weight:850;white-space:nowrap}.status.ok{color:var(--ok)}.status.warn{color:var(--warn)}.status.bad{color:var(--bad)}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.table{width:100%;border-collapse:collapse}.table th,.table td{border-bottom:1px solid var(--line);padding:8px;text-align:left;vertical-align:top}.table th{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}.table input[type="checkbox"]{width:auto}.tab-url{min-width:340px}.compact{width:120px}.authcol{width:155px}label{display:block;font-size:12px;color:var(--muted);font-weight:850;margin-bottom:5px}input,select,textarea{width:100%;border:1px solid #cbd5e1;border-radius:8px;padding:9px 10px;font:inherit;background:white;color:var(--ink)}button,.button{border:0;border-radius:8px;padding:10px 14px;background:var(--accent);color:white;font:inherit;font-weight:850;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:8px}button.secondary{background:#475467}button.ghost{background:#e7ecf5;color:#1f2937}button.danger{background:#a61b1b}button.small{padding:7px 10px;font-size:12px}button:disabled{opacity:.45;cursor:not-allowed}.row-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.setup-summary{display:flex;gap:10px;flex-wrap:wrap;margin-top:12px}.chip{border:1px solid var(--line);background:#f8fafc;border-radius:999px;padding:6px 10px;font-size:12px;color:#344054}.callout{border-left:4px solid var(--accent);background:#f5f8ff;padding:12px 14px;border-radius:6px;margin:12px 0}.result{white-space:pre-wrap;font-size:13px;line-height:1.5}.code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#111827;color:#d1fae5;border-radius:8px;padding:12px;overflow:auto;max-height:360px}.invalid{color:var(--bad);font-size:12px;margin-top:4px}.resolved{font-size:12px;color:var(--ok);margin-top:4px;word-break:break-all}.footer{display:flex;justify-content:space-between;gap:12px;align-items:center;position:sticky;bottom:0;background:linear-gradient(180deg,rgba(246,248,251,.72),var(--bg));padding:12px 0}.hidden{display:none}.param-row{display:grid;grid-template-columns:220px 1fr auto;gap:8px;margin-bottom:8px}.section-title{display:flex;justify-content:space-between;gap:10px;align-items:flex-start}.two-col{display:grid;grid-template-columns:minmax(0,1fr) 330px;gap:14px}
@media(max-width:900px){main{padding:16px}.grid,.two-col{grid-template-columns:1fr}.tab-url{min-width:0}.param-row{grid-template-columns:1fr}.hero{display:block}.footer{display:block}.footer .row-actions{margin-top:10px}}
</style>
</head>
<body>
<main>
  <div class="panel hero" data-testid="recording-summary">
    <div>
      <div class="eyebrow">Browsy recording setup</div>
      <h1 id="pageTitle">New automation</h1>
      <p class="hint">Enter only the starting browser context: which tabs open, which tabs need auth, and any URL parameters. After that, Browsy learns the workflow from browser observation.</p>
      <div id="workflow" class="mini" data-testid="workflow-label"></div>
    </div>
    <div>
      <span class="badge" id="app" data-testid="app-label"></span>
      <div class="mini" style="margin-top:8px"><strong>Status</strong>: <span id="status" data-testid="recording-status">Loading...</span></div>
    </div>
  </div>

  <div class="two-col">
    <section>
      <div class="panel">
        <div class="section-title">
          <div>
            <h2>1. URL parameters</h2>
            <p class="hint">Add only values needed to resolve starting URLs, for example <strong>statementMonth</strong> or <strong>accountId</strong>. Use them in tab URLs as <strong>{statementMonth}</strong> or <strong>{{statementMonth}}</strong>.</p>
          </div>
          <button type="button" class="ghost small" id="addParamBtn" data-testid="add-param-button">Add Parameter</button>
        </div>
        <div id="paramsBody" data-testid="url-params"></div>
        <div class="row-actions">
          <button type="button" class="ghost" id="addMissingParamsBtn" data-testid="add-missing-params-button">Add Missing From URLs</button>
        </div>
      </div>

      <div class="panel">
        <div class="section-title">
          <div>
            <h2>2. Tabs and auth</h2>
            <p class="hint">Configure the tabs Browsy should open before recording. Mark auth-required tabs and give each one a stable auth profile name.</p>
          </div>
          <button type="button" class="ghost small" id="addTabBtn" data-testid="add-tab-button">Add Tab</button>
        </div>
        <input id="authProfileId" data-testid="auth-profile-id" class="hidden" aria-hidden="true"/>
        <table class="table" data-testid="tabs-table">
          <thead><tr><th class="compact">ID</th><th>Title</th><th class="tab-url">URL or template</th><th>Site</th><th>Needs auth</th><th class="authcol">Auth profile</th><th></th></tr></thead>
          <tbody id="tabsBody"></tbody>
        </table>
        <div id="setupValidation" data-testid="setup-validation" class="mini"></div>
        <div class="row-actions">
          <button type="button" id="saveSetupBtn" data-testid="save-setup-button">Save Setup</button>
          <button type="button" class="ghost" id="checkAuthBtn" data-testid="check-auth-button">Check Auth</button>
          <button type="button" class="ghost" id="releaseStaleLockBtn" data-testid="release-stale-lock-button">Release Stale Locks</button>
        </div>
      </div>

      <div class="panel">
        <h2>3. Observe browser flow</h2>
        <p class="hint">Start recording only after the tabs/auth setup is correct. Use the opened browser tabs normally, then stop recording. The observed browser events become the workflow package.</p>
        <div class="row-actions">
          <button id="startRecordingBtn" data-testid="start-recording-button">Start Recording</button>
          <button id="stopRecordingBtn" data-testid="stop-recording-button" class="secondary">Done Recording</button>
          <button id="abandonRecordingBtn" data-testid="abandon-recording-button" class="danger">Abandon Recording</button>
        </div>
        <details style="margin-top:14px">
          <summary class="mini">Manual observation/events import</summary>
          <textarea id="observationInput" data-testid="observation-input" placeholder='{"schemaVersion":"browsy.observation.v1", ...}'></textarea>
        </details>
      </div>
    </section>

    <aside>
      <div class="panel">
        <h2>Ready checklist</h2>
        <div id="setupSummary" class="setup-summary" data-testid="setup-summary"></div>
        <div class="callout mini">No field mapping, outputs, source-data prose, or completion policy is needed here. Those are inferred from the recording and verified later.</div>
      </div>
      <div class="panel">
        <h2>After recording</h2>
        <p class="hint">Import only after Done Recording. This keeps the UI focused on setup while preserving the existing Browsy contract flow.</p>
        <div class="row-actions">
          <button id="importWorkflowBtn" data-testid="import-workflow-button">Import Observed Workflow</button>
          <button id="viewContractBtn" data-testid="view-contract-button" class="ghost">View Contract</button>
        </div>
      </div>
    </aside>
  </div>

  <div class="panel">
    <h2>Result</h2>
    <div id="actionResult" data-testid="action-result" class="result mini"></div>
    <pre id="contractOutput" data-testid="contract-output" class="code">{}</pre>
  </div>
</main>
<script>
const recordingSessionId=${JSON.stringify(recordingSessionId)};
let currentRecording=null,tabsDraft=[],paramsDraft=[],actionInFlight=false;
function el(id){return document.getElementById(id)}
function esc(value){return String(value==null?'':value).replace(/[&<>\"]/g,function(ch){return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[ch]})}
async function api(path,options){const res=await fetch(path,options||{});const data=await res.json().catch(function(){return{}});if(!res.ok||data.ok===false){const err=new Error(data.error||res.statusText||'Request failed');err.data=data;err.status=res.status;throw err}return data}
function isRecordingActive(){return currentRecording&&currentRecording.status==='recording'}
function isImported(){return currentRecording&&currentRecording.status==='imported'}
function hasBraceVars(value){return /\{\{[^{}]+\}\}|\{[^{}]+\}/.test(String(value||''))}
function extractTemplateVars(value){const out=[],seen={};const re=/\{\{([^{}]+)\}\}|\{([^{}]+)\}/g;let m;while((m=re.exec(String(value||'')))!==null){const key=String(m[1]||m[2]||'').trim();if(key&&!seen[key]){seen[key]=true;out.push(key)}}return out}
function isBadUrl(url){return !url||/PASTE_|YOUR_|_HERE/i.test(url)||!(url.startsWith('http://')||url.startsWith('https://')||url.startsWith('data:'))}
function flattenParams(sample){if(!sample||typeof sample!=='object'||Array.isArray(sample))return[];return Object.entries(sample).filter(function(pair){return pair[1]!==undefined&&typeof pair[1]!=='function'}).map(function(pair){let value=pair[1];if(value&&typeof value==='object')value=JSON.stringify(value);return{key:pair[0],value:String(value==null?'':value)}})}
function syncParams(){paramsDraft=[...document.querySelectorAll('[data-param-row]')].map(function(row){return{key:(row.querySelector('[data-param-key]')?.value||'').trim(),value:(row.querySelector('[data-param-value]')?.value||'').trim()}}).filter(function(p){return p.key||p.value})}
function paramsObject(){syncParams();const out={};for(const p of paramsDraft){if(!p.key)continue;let value=p.value;if(/^\s*(\{|\[)/.test(value)){try{value=JSON.parse(value)}catch{}}out[p.key]=value}return out}
function renderParams(){const body=el('paramsBody');if(!paramsDraft.length)body.innerHTML='<div class="mini">No URL parameters yet. Add only values that appear inside starting URL templates.</div>';else body.innerHTML=paramsDraft.map(function(p,i){return '<div class="param-row" data-param-row="'+i+'"><input data-param-key placeholder="parameter name" value="'+esc(p.key)+'"><input data-param-value placeholder="value used to resolve URL templates" value="'+esc(p.value)+'"><button type="button" class="danger small" data-remove-param="'+i+'">Remove</button></div>'}).join('');body.querySelectorAll('input').forEach(function(input){input.addEventListener('input',function(){syncParams();validateSetup()})});body.querySelectorAll('[data-remove-param]').forEach(function(btn){btn.onclick=function(){syncParams();paramsDraft.splice(Number(btn.dataset.removeParam),1);renderParams();validateSetup()}})}
function resolveLocal(template){let out=String(template||'');const params=paramsObject();out=out.replace(/\{\{([^{}]+)\}\}|\{([^{}]+)\}/g,function(match,a,b){const key=String(a||b||'').trim();const value=params[key];return value===undefined||value===null||value===''?match:String(value)});return out}
function missingTemplateVars(){syncTabs();syncParams();const params=paramsObject();const missing=[];const seen={};for(const tab of tabsDraft){for(const key of extractTemplateVars(tab.urlTemplate||tab.url)){if((params[key]===undefined||params[key]===null||params[key]==='')&&!seen[key]){seen[key]=true;missing.push(key)}}}return missing}
function syncTabs(){tabsDraft=[...document.querySelectorAll('#tabsBody tr')].map(function(row,index){const get=function(f){return row.querySelector('[data-field="'+f+'"]')};const rawUrl=(get('url')?.value||'').trim();const authProfile=(get('authProfileId')?.value||'').trim();const tab={id:(get('id')?.value||('tab'+(index+1))).trim(),title:(get('title')?.value||'').trim(),url:resolveLocal(rawUrl),siteId:(get('siteId')?.value||'').trim(),requiresAuth:!!get('requiresAuth')?.checked,authProfileId:authProfile||null};if(hasBraceVars(rawUrl))tab.urlTemplate=rawUrl;return tab})}
function displayUrl(tab){return tab.urlTemplate||tab.url||''}
function tabRow(tab,index){const disabled=isRecordingActive()||isImported()?' disabled':'';const raw=displayUrl(tab);const invalid=isBadUrl(raw);const resolved=hasBraceVars(raw)?resolveLocal(raw):'';const authProfile=tab.authProfileId||((tab.requiresAuth&&(tab.siteId||tab.id))?String(tab.siteId||tab.id).replace(/[^a-z0-9-_]/gi,'-').toLowerCase():'');const authButton=tab.requiresAuth?'<button type="button" class="ghost small" data-auth-index="'+index+'"'+disabled+'>Open Auth</button>':'<span class="mini">No auth</span>';let msg='Ready';let cls='mini';if(invalid){msg='Enter a real URL or URL template';cls='invalid'}else if(hasBraceVars(raw)){msg='Template resolves to '+esc(resolved);cls=extractTemplateVars(raw).some(function(k){const p=paramsObject();return !p[k]})?'invalid':'resolved'}return '<tr><td><input data-field="id" value="'+esc(tab.id||('tab'+(index+1)))+'"'+disabled+'></td><td><input data-field="title" value="'+esc(tab.title||'')+'"'+disabled+'></td><td><input data-field="url" value="'+esc(raw)+'" placeholder="https://.../{parameter}"'+disabled+'><div class="'+cls+'">'+msg+'</div></td><td><input data-field="siteId" value="'+esc(tab.siteId||'')+'"'+disabled+'></td><td><label style="margin:0;color:var(--ink);font-size:13px"><input type="checkbox" data-field="requiresAuth" '+(tab.requiresAuth?'checked':'')+disabled+'> Required</label></td><td><input data-field="authProfileId" value="'+esc(authProfile)+'" placeholder="profile id"'+disabled+'></td><td><div class="row-actions" style="margin:0">'+authButton+'<button type="button" class="danger small" data-remove-tab="'+index+'"'+disabled+'>Remove</button></div></td></tr>'}
function renderTabs(){el('tabsBody').innerHTML=tabsDraft.map(tabRow).join('');el('tabsBody').querySelectorAll('input').forEach(function(input){input.addEventListener('input',function(){validateSetup()});input.addEventListener('change',function(){validateSetup()})});el('tabsBody').querySelectorAll('[data-remove-tab]').forEach(function(btn){btn.onclick=function(){syncTabs();tabsDraft.splice(Number(btn.dataset.removeTab),1);renderTabs();validateSetup()}});el('tabsBody').querySelectorAll('[data-auth-index]').forEach(function(btn){btn.onclick=function(){openAuthForTab(Number(btn.dataset.authIndex))}})}
function addMissingParams(){syncTabs();syncParams();const existing=paramsObject();for(const tab of tabsDraft){for(const key of extractTemplateVars(displayUrl(tab))){if(existing[key]===undefined){paramsDraft.push({key:key,value:''});existing[key]=''}}}renderParams();validateSetup()}
function setupStats(){syncTabs();const authTabs=tabsDraft.filter(function(t){return t.requiresAuth}).length;const missing=missingTemplateVars().length;return{tabs:tabsDraft.length,authTabs:authTabs,params:Object.keys(paramsObject()).length,missing:missing}}
function renderSummary(){const stats=setupStats();el('setupSummary').innerHTML='<span class="chip">Tabs: '+stats.tabs+'</span><span class="chip">Auth tabs: '+stats.authTabs+'</span><span class="chip">URL params: '+stats.params+'</span><span class="chip">Missing values: '+stats.missing+'</span>'}
function validateSetup(){syncParams();syncTabs();const bad=tabsDraft.filter(function(t){return isBadUrl(displayUrl(t))});const missing=missingTemplateVars();let msg=bad.length?'Fix '+bad.length+' tab URL(s) before recording.':missing.length?'Fill URL parameter value(s): '+missing.join(', '):'Setup looks ready.';let cls=bad.length||missing.length?'status bad':'status ok';if(isRecordingActive()){msg='Recording is active. Click Done Recording before editing setup.';cls='status warn'}else if(isImported()){msg='Workflow imported. Create a new recording session to edit setup.';cls='status warn'}el('setupValidation').textContent=msg;el('setupValidation').className=cls;const blocked=actionInFlight||bad.length>0||missing.length>0||isRecordingActive()||isImported();el('startRecordingBtn').disabled=blocked;el('stopRecordingBtn').disabled=actionInFlight||!isRecordingActive();el('abandonRecordingBtn').disabled=actionInFlight||!isRecordingActive();el('saveSetupBtn').disabled=actionInFlight||isRecordingActive()||isImported();el('addTabBtn').disabled=actionInFlight||isRecordingActive()||isImported();el('addParamBtn').disabled=actionInFlight||isRecordingActive()||isImported();el('addMissingParamsBtn').disabled=actionInFlight||isRecordingActive()||isImported();el('importWorkflowBtn').disabled=actionInFlight||!(currentRecording&&currentRecording.status==='stopped'||currentRecording&&currentRecording.status==='import_failed'||isImported());el('viewContractBtn').disabled=actionInFlight||!isImported();renderSummary();return !bad.length&&!missing.length&&!isRecordingActive()&&!isImported()}
function autoIntent(){return 'Operator supplies only starting tabs, auth requirements, and URL template parameters. Browser observation records the business workflow, including fields, downloads, uploads, outputs, and replay notes. Do not infer extra source-data UI fields from setup.'}
async function saveSetup(){if(isRecordingActive())throw new Error('Click Done Recording before saving setup.');syncTabs();const recordingSetup={...(currentRecording.recordingSetup||{}),tabs:tabsDraft};const payload={recordingSetup:recordingSetup,callbackUrl:currentRecording.callbackUrlTemplate||currentRecording.callbackUrl||'',fieldContractIntent:autoIntent(),completionPolicy:{action:'wait_for_human_submission',notes:'Workflow details are captured from browser observation after setup.'},writebackTargets:currentRecording.writebackTargets||[]};const data=await api('/api/recordings/'+encodeURIComponent(recordingSessionId)+'/setup',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});await load();return data}
function authBodyForTab(tab){const targetUrl=resolveLocal(tab.authCheckUrl||tab.urlTemplate||tab.url);const authProfileId=tab.authProfileId||tab.siteId||tab.id;if(!authProfileId)throw new Error('Auth profile is required for '+(tab.title||tab.id));if(hasBraceVars(targetUrl))throw new Error('Fill URL parameters before auth for '+(tab.title||tab.id));return{appId:currentRecording.appId||null,workflowId:currentRecording.workflowId||null,authProfileId:authProfileId,targetUrl:targetUrl}}
async function openAuthForTab(index){await runAction('Opening auth profile',async function(){syncTabs();await saveSetup();const tab=tabsDraft[index];if(!tab||!tab.requiresAuth)throw new Error('Tab does not require auth.');const body=authBodyForTab(tab);const data=await api('/api/auth-profiles/prepare',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,options:{headless:false}})});el('actionResult').className='result status ok';el('actionResult').textContent='Auth browser opened for '+body.authProfileId+'. Log in manually, complete 2FA, then close that browser and click Check Auth.';return data})}
async function checkAuth(){syncTabs();const rows=[];for(const tab of tabsDraft.filter(function(t){return t.requiresAuth||t.authProfileId})){const body=authBodyForTab(tab);const data=await api('/api/auth-profiles/preflight',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,options:{headless:true},rules:[{when:'urlIncludes',value:'login',code:'auth_required'},{when:'urlIncludes',value:'signin',code:'auth_required'},{when:'textIncludes',value:'sign in',code:'auth_required'}]})});rows.push(body.authProfileId+': '+(data.preflight&&data.preflight.ok?'authenticated':'auth required')+' ('+((data.preflight&&data.preflight.finalUrl)||'no final url')+')')}return rows.join('\n')||'No auth-required tabs configured.'}
async function releaseStaleLocks(){syncTabs();const rows=[];const seen={};for(const tab of tabsDraft.filter(function(t){return t.requiresAuth||t.authProfileId})){const id=tab.authProfileId||tab.siteId||tab.id;if(!id||seen[id])continue;seen[id]=true;const data=await api('/api/auth-profiles/release-stale-lock',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({appId:currentRecording.appId||null,workflowId:currentRecording.workflowId||null,authProfileId:id})});const lockedAfter=data.recovery.lockedAfter??!!(data.recovery.lock&&data.recovery.lock.locked);rows.push(id+': '+(data.recovery.recoveryAction||'none')+', locked after release: '+lockedAfter)}return rows.join('\n')||'No auth profiles configured.'}
async function load(){const data=await api('/api/recordings/'+encodeURIComponent(recordingSessionId));const r=data.recording;currentRecording=r;tabsDraft=((r.recordingSetup&&r.recordingSetup.tabs)||[]).map(function(t){return{...t}});paramsDraft=flattenParams(r.samplePayload||{});el('status').textContent=r.status;el('status').className=r.status==='imported'?'status ok':r.status==='recording'?'status warn':'status';el('pageTitle').textContent=r.workflowName||r.workflowId||'New automation';el('app').textContent=(r.appName||r.appId||'App')+(r.appId?' / '+r.appId:'');el('workflow').textContent=(r.workflowName||r.workflowId||'Workflow')+(r.workflowId?' / '+r.workflowId:'')+(r.targetUrl?' -> '+r.targetUrl:'');renderParams();renderTabs();validateSetup()}
async function runAction(label,fn){if(actionInFlight)return;actionInFlight=true;el('actionResult').className='result status warn';el('actionResult').textContent=label+'...';el('contractOutput').textContent='{}';validateSetup();try{const result=await fn();if(el('actionResult').textContent===label+'...'){el('actionResult').className='result status ok';el('actionResult').textContent='Done.'}return result}catch(err){let msg='Error: '+(err.message||String(err));if(err.data)msg+='\n'+JSON.stringify(err.data,null,2);el('actionResult').className='result status bad';el('actionResult').textContent=msg;el('contractOutput').textContent=JSON.stringify({error:err.message||String(err),details:err.data||null},null,2)}finally{actionInFlight=false;validateSetup()}}
el('addParamBtn').onclick=function(){syncParams();paramsDraft.push({key:'',value:''});renderParams();validateSetup()};
el('addMissingParamsBtn').onclick=addMissingParams;
el('addTabBtn').onclick=function(){syncTabs();tabsDraft.push({id:'tab'+(tabsDraft.length+1),title:'',url:'',siteId:'',requiresAuth:false,authProfileId:null});renderTabs();validateSetup()};
el('saveSetupBtn').onclick=function(){runAction('Saving setup',async function(){await saveSetup();el('actionResult').className='result status ok';el('actionResult').textContent='Saved setup. Start Recording is available when URLs and parameters are valid.'})};
el('checkAuthBtn').onclick=function(){runAction('Checking auth',async function(){const text=await checkAuth();el('actionResult').className=text.includes('auth required')?'result status warn':'result status ok';el('actionResult').textContent=text})};
el('releaseStaleLockBtn').onclick=function(){runAction('Releasing stale auth locks',async function(){const text=await releaseStaleLocks();el('actionResult').className='result status ok';el('actionResult').textContent=text})};
el('startRecordingBtn').onclick=function(){runAction('Starting recording',async function(){if(!validateSetup())throw new Error('Fix setup before starting.');await api('/api/health');await saveSetup();const data=await api('/api/recordings/'+encodeURIComponent(recordingSessionId)+'/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})});el('actionResult').className='result status ok';el('actionResult').textContent='Recording started. Mode: '+((data.launch&&data.launch.mode)||'unknown')+'. Use the opened tabs, then click Done Recording.';await load();return data})};
el('stopRecordingBtn').onclick=function(){runAction('Stopping recording',async function(){let payload={};const raw=el('observationInput').value.trim();if(raw){const parsed=JSON.parse(raw);payload=parsed.events?{events:parsed.events,observation:parsed.observation}:{observation:parsed}}const data=await api('/api/recordings/'+encodeURIComponent(recordingSessionId)+'/stop',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});el('actionResult').className='result status ok';el('actionResult').textContent='Recording stopped. Import the observed workflow when ready.';await load();return data})};
el('abandonRecordingBtn').onclick=function(){runAction('Abandoning recording',async function(){const data=await api('/api/recordings/'+encodeURIComponent(recordingSessionId)+'/abandon',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reason:'abandoned from recording page'})});el('actionResult').className='result status ok';el('actionResult').textContent='Recording abandoned. Browser closed and auth profile cleanup ran.';await load();return data})};
el('importWorkflowBtn').onclick=function(){runAction('Importing workflow',async function(){const data=await api('/api/recordings/'+encodeURIComponent(recordingSessionId)+'/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({overwrite:true,autoRegisterApp:true})});el('contractOutput').textContent=JSON.stringify(data.contract||data.recording,null,2);el('actionResult').className='result status ok';el('actionResult').textContent='Imported workflowRef: '+data.workflowRef;await load();return data})};
el('viewContractBtn').onclick=function(){runAction('Loading contract',async function(){const data=await api('/api/recordings/'+encodeURIComponent(recordingSessionId)+'/contract');el('contractOutput').textContent=JSON.stringify(data.contract,null,2);return data})};
window.showStep=function(){};
load().catch(function(err){el('setupValidation').className='status bad';el('setupValidation').textContent=err.message});
</script>
</body>
</html>`;
}
