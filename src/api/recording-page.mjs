export function renderEditableRecordingPage(recordingSessionId) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Browsy Record Automation</title>
<style>
:root{--ink:#17202a;--muted:#697386;--line:#dbe1ea;--panel:#fff;--bg:#f5f7fb;--accent:#2457d6;--accent2:#0f766e;--warn:#b45309;--bad:#b42318}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:1120px;margin:0 auto;padding:28px}.shell{display:grid;grid-template-columns:260px 1fr;gap:20px}.rail{background:#101828;color:white;border-radius:8px;padding:20px;align-self:start;position:sticky;top:20px}.brand{font-weight:900;font-size:18px;margin-bottom:18px}.stepnav{display:flex;flex-direction:column;gap:8px}.stepnav button{border:1px solid rgba(255,255,255,.16);background:transparent;color:#dbe4ff;border-radius:8px;padding:10px;text-align:left;font:inherit;font-weight:750;cursor:pointer}.stepnav button.active{background:white;color:#101828}.session{font-size:12px;color:#b7c4d8;line-height:1.5;margin-top:18px;word-break:break-all}.panel{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:22px;margin-bottom:14px}.hero{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}.eyebrow{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--accent);font-weight:900}h1{font-size:28px;line-height:1.15;margin:6px 0 8px}h2{font-size:20px;margin:0 0 8px}.hint{color:var(--muted);font-size:14px;line-height:1.55;margin:0 0 18px}.badge{display:inline-flex;border-radius:999px;background:#eef4ff;color:#173b91;padding:5px 10px;font-size:12px;font-weight:800}.status.ok{color:var(--accent2)}.status.warn{color:var(--warn)}.status.bad{color:var(--bad)}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.table{width:100%;border-collapse:collapse}.table th,.table td{border-bottom:1px solid var(--line);padding:8px;text-align:left;vertical-align:top}.table th{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}.tab-url{min-width:320px}label{display:block;font-size:12px;color:var(--muted);font-weight:850;margin-bottom:5px}input,select,textarea{width:100%;border:1px solid #cbd5e1;border-radius:8px;padding:9px 10px;font:inherit;background:white;color:var(--ink)}textarea{min-height:150px;resize:vertical;line-height:1.5}.row-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}button,.button{border:0;border-radius:8px;padding:10px 14px;background:var(--accent);color:white;font:inherit;font-weight:850;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:8px}button.secondary,.button.secondary{background:#475467}button.ghost{background:#e7ecf5;color:#1f2937}button.danger{background:#a61b1b}button:disabled{opacity:.45;cursor:not-allowed}.pillbox{display:flex;flex-wrap:wrap;gap:6px}.pillgroup{width:100%;margin:0 0 10px}.pillgroup-title{font-size:11px;font-weight:900;text-transform:uppercase;color:var(--muted);letter-spacing:.04em;margin:0 0 5px}.pill{border:1px solid var(--line);border-radius:999px;padding:5px 9px;background:#f8fafc;font-size:12px}.step{display:none}.step.active{display:block}.mini{font-size:12px;color:var(--muted);line-height:1.45}.callout{border-left:4px solid var(--accent);background:#f5f8ff;padding:12px 14px;border-radius:6px;margin:12px 0}.result{white-space:pre-wrap;font-size:13px;line-height:1.5}.code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#111827;color:#d1fae5;border-radius:8px;padding:12px;overflow:auto;max-height:360px}.writeback-row{display:grid;grid-template-columns:1fr 1fr auto;gap:8px;margin-bottom:8px}.invalid{color:var(--bad);font-size:12px;margin-top:4px}.footer{display:flex;justify-content:space-between;gap:12px;margin-top:18px}.mobile-note{display:none}
@media(max-width:800px){main{padding:16px}.shell{display:block}.rail{position:static;margin-bottom:14px}.grid{grid-template-columns:1fr}.tab-url{min-width:0}.writeback-row{grid-template-columns:1fr}.mobile-note{display:block}.footer{position:sticky;bottom:0;background:var(--bg);padding:10px 0}}
</style>
</head>
<body>
<main>
  <div class="shell">
    <aside class="rail">
      <div class="brand">Browsy</div>
      <div class="stepnav">
        <button data-nav="1" class="active">1. Source data</button>
        <button data-nav="2">2. Tabs and auth</button>
        <button data-nav="3">3. Done behavior</button>
        <button data-nav="4">4. Record</button>
        <button data-nav="5">5. Review</button>
      </div>
      <div class="session">
        <strong>Session</strong><br><span id="recordingSessionId">${escapeHtml(recordingSessionId)}</span><br><br>
        <strong>Status</strong><br><span id="status" data-testid="recording-status">Loading...</span>
      </div>
    </aside>

    <section>
      <div class="panel hero" data-testid="recording-summary">
        <div>
          <div class="eyebrow">Record Automation</div>
          <h1 id="pageTitle">New Browsy automation</h1>
          <p class="hint" id="pageSubtitle">Create the contract, record the browser flow, and keep final actions gated.</p>
          <div id="workflow" class="mini" data-testid="workflow-label"></div>
        </div>
        <span class="badge" id="app" data-testid="app-label"></span>
      </div>

      <div class="step active" data-step="1">
        <div class="panel">
          <h2 id="sourceDataTitle">What info do I need from the source app?</h2>
          <p class="hint" id="sourceDataHint">Describe the data contract in the language used by the source app. Include global fields, repeated item fields, assets, and any computed values. Browsy stores this beside the DOM recording so the generated contract can bind source fields to observed controls.</p>
          <textarea id="fieldContractIntent" data-testid="field-contract-intent" placeholder="Example: number of tracks in this release, release date, cover art, for each track: audio file, title, AI disclosure, credits..."></textarea>
          <div class="callout">
            <strong id="sourceFieldsTitle">Current source-provided fields</strong>
            <div id="payloadFields" data-testid="payload-fields" class="pillbox"></div>
          </div>
          <div class="grid">
            <div>
              <label>Available variables</label>
              <div id="availableVariables" data-testid="available-variables" class="pillbox"></div>
            </div>
            <div>
              <label>File bindings</label>
              <div id="fileBindings" data-testid="file-bindings" class="pillbox"></div>
            </div>
          </div>
          <details open style="margin-top:14px">
            <summary class="mini">Sample payload</summary>
            <pre id="samplePayload" data-testid="sample-payload" class="code">{}</pre>
          </details>
        </div>
      </div>

      <div class="step" data-step="2">
        <div class="panel">
          <h2>What tabs do you need open, which ones require auth?</h2>
          <p class="hint">List the source app page and every target page Browsy should open before recording. Use the variables from Source data in URLs with {fieldId} or {{fieldId}}. Auth-required tabs use a saved local profile before any automation runs.</p>
          <div class="grid">
            <div><label>Shared auth profile</label><input id="authProfileId" data-testid="auth-profile-id" placeholder="e.g. distrokid"/></div>
            <div><label>Callback URL</label><input id="callbackUrl" data-testid="callback-url" placeholder="optional"/></div>
          </div>
          <table class="table" data-testid="tabs-table">
            <thead><tr><th>ID</th><th>Title</th><th class="tab-url">URL</th><th>Site</th><th>Auth</th><th></th></tr></thead>
            <tbody id="tabsBody"></tbody>
          </table>
          <div class="row-actions">
            <button type="button" class="ghost" id="addTabBtn" data-testid="add-tab-button">Add Tab</button>
            <button type="button" id="saveSetupBtn" data-testid="save-setup-button">Save Setup</button>
            <button type="button" class="ghost" id="checkAuthBtn" data-testid="check-auth-button">Check Auth</button>
            <button type="button" class="ghost" id="releaseStaleLockBtn" data-testid="release-stale-lock-button">Release Stale Lock</button>
          </div>
          <div id="setupValidation" data-testid="setup-validation" class="mini"></div>
        </div>
      </div>

      <div class="step" data-step="3">
        <div class="panel">
          <h2>What should Browsy do when done?</h2>
          <p class="hint">Pick the end behavior before recording so final actions and writebacks are part of the contract, not improvised during a live run.</p>
          <div class="grid">
            <div>
              <label>Completion behavior</label>
              <select id="completionAction" data-testid="completion-action">
                <option value="wait_for_human_submission">Wait for human submission</option>
                <option value="require_approval_before_submit">Ask me for approval before submit</option>
                <option value="write_outputs_to_source_app">Write captured info back to the source app</option>
                <option value="do_nothing">Do nothing</option>
                <option value="close_browser">Do nothing and close browser</option>
              </select>
            </div>
            <div>
              <label>Notes</label>
              <input id="completionNotes" data-testid="completion-notes" placeholder="e.g. capture HyperFollow URL"/>
            </div>
          </div>
          <div style="margin-top:16px">
            <label>Captured outputs</label>
            <div id="expectedOutputs" data-testid="expected-outputs" class="pillbox"></div>
          </div>
          <div style="margin-top:16px">
            <label>Writeback targets</label>
            <div id="writebackRows" data-testid="writeback-targets"></div>
            <button type="button" class="ghost" id="addWritebackBtn">Add Writeback</button>
          </div>
          <div style="margin-top:16px">
            <label>Manual checkpoints</label>
            <div id="humanCheckpoints" data-testid="human-checkpoints" class="pillbox"></div>
          </div>
        </div>
      </div>

      <div class="step" data-step="4">
        <div class="panel">
          <h2>Record how you interact with the tabs</h2>
          <p class="hint">Start recording after source data, tabs, auth, and done behavior are saved. Browsy records selectors, uploads, page state, outputs, screenshots, and dangerous-action candidates. Final actions remain gated.</p>
          <div class="row-actions">
            <button id="startRecordingBtn" data-testid="start-recording-button">Start Recording</button>
            <button id="stopRecordingBtn" data-testid="stop-recording-button" class="secondary">Done Recording</button>
            <button id="abandonRecordingBtn" data-testid="abandon-recording-button" class="danger">Abandon Recording</button>
          </div>
          <div id="actionResult" data-testid="action-result" class="result mini"></div>
          <details style="margin-top:14px">
            <summary class="mini">Manual observation/events import</summary>
            <textarea id="observationInput" data-testid="observation-input" placeholder='{"schemaVersion":"browsy.observation.v1", ...}'></textarea>
          </details>
        </div>
      </div>

      <div class="step" data-step="5">
        <div class="panel">
          <h2>Review the generated contract</h2>
          <p class="hint">Import only after the recording is done. The contract is what the source app should call later; selectors remain observed until verified by discovery/field-map verification.</p>
          <div class="row-actions">
            <button id="importWorkflowBtn" data-testid="import-workflow-button">Import Workflow</button>
            <button id="viewContractBtn" data-testid="view-contract-button" class="ghost">View Contract</button>
          </div>
          <pre id="contractOutput" data-testid="contract-output" class="code">{}</pre>
        </div>
      </div>

      <div class="footer">
        <button id="prevBtn" class="ghost">Back</button>
        <button id="nextBtn">Next</button>
      </div>
    </section>
  </div>
</main>
<script>
const recordingSessionId=${JSON.stringify(recordingSessionId)};
let currentRecording=null,tabsDraft=[],writebackDraft=[],step=1,actionInFlight=false;
const completionLabels={wait_for_human_submission:'Wait for human submission',require_approval_before_submit:'Ask me for approval before submit',write_outputs_to_source_app:'Write captured info back to the source app',do_nothing:'Do nothing',close_browser:'Do nothing and close browser'};
function el(id){return document.getElementById(id)}
function esc(value){return String(value||'').replace(/[&<>"]/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]))}
function isRecordingActive(){return currentRecording&&currentRecording.status==='recording'}
function isImported(){return currentRecording&&currentRecording.status==='imported'}
function hasBraceVars(value){return /\{\{[^{}]+\}\}|\{[^{}]+\}/.test(String(value||''))}
function isBadUrl(url){return !url||/PASTE_|YOUR_|_HERE/i.test(url)||!(url.startsWith('http://')||url.startsWith('https://')||url.startsWith('data:'))}
function displayUrl(tab){return tab.urlTemplate||tab.url||''}
function sourceAppLabel(r){return (r&&((r.sourceApp&&r.sourceApp.name)||r.appName||r.appId))||'the source app'}
async function api(path,options={}){const res=await fetch(path,options);const data=await res.json().catch(()=>({}));if(!res.ok||data.ok===false){const err=new Error(data.error||res.statusText||'Request failed');err.data=data;err.status=res.status;throw err}return data}
function renderPills(target,items,formatter){target.innerHTML='';if(!items||!items.length){target.innerHTML='<span class="mini">None declared yet</span>';return}for(const item of items){const span=document.createElement('span');span.className='pill';span.textContent=formatter(item);target.appendChild(span)}}
function flattenPayload(value,prefix='',out=[]){if(prefix)out.push(prefix);if(!value||typeof value!=='object')return out;if(Array.isArray(value)){if(prefix)out.push(prefix+'.length');if(value[0]&&typeof value[0]==='object')flattenPayload(value[0],prefix?prefix+'[]':'items[]',out);return out}for(const key of Object.keys(value))flattenPayload(value[key],prefix?prefix+'.'+key:key,out);return out}
function uniquePaths(items){const seen=new Set();const out=[];for(const item of items){const path=typeof item==='string'?item:item&&((item.path)||(item.id)||(item.label));if(!path||seen.has(path))continue;seen.add(path);out.push(path)}return out}
function groupForPath(path){if(path==='releaseId'||path==='albumId'||path==='album.id'||path==='album.releaseId')return'Release fields';if(path.startsWith('album.'))return'Album fields';if(path.startsWith('tracks'))return'Track fields';if(path.startsWith('derived.')||path==='numberOfSongs')return'Derived fields';return'Other fields'}
function sortPaths(paths){const order={'Release fields':0,'Album fields':1,'Track fields':2,'Derived fields':3,'Other fields':4};return paths.slice().sort((a,b)=>(order[groupForPath(a)]-order[groupForPath(b)])||a.localeCompare(b))}
function renderGroupedVariables(target,items){target.innerHTML='';const paths=sortPaths(uniquePaths(items));if(!paths.length){target.innerHTML='<span class="mini">None declared yet</span>';return}let current='';let box=null;for(const path of paths){const group=groupForPath(path);if(group!==current){current=group;const wrap=document.createElement('div');wrap.className='pillgroup';wrap.innerHTML='<div class="pillgroup-title">'+esc(group)+'</div>';box=document.createElement('div');box.className='pillbox';wrap.appendChild(box);target.appendChild(wrap)}const span=document.createElement('span');span.className='pill';span.textContent=path;box.appendChild(span)}}
function tabRow(tab,index){const disabled=isRecordingActive()||isImported()?' disabled':'';const url=displayUrl(tab);const invalid=isBadUrl(url);const templated=hasBraceVars(url);const resolved=tab.urlTemplate&&tab.urlTemplate!==tab.url?tab.url:'';return '<tr><td><input data-field="id" value="'+esc(tab.id||('tab'+(index+1)))+'"'+disabled+'></td><td><input data-field="title" value="'+esc(tab.title||'')+'"'+disabled+'></td><td><input data-field="url" value="'+esc(url)+'" placeholder="https://.../{sourceId}"'+disabled+'><div class="'+(invalid?'invalid':'mini')+'">'+(invalid?'Enter a real URL or URL template before recording':(templated?'Template URL'+(resolved?' resolves to '+esc(resolved):' - add matching source data before launch'):'Ready'))+'</div></td><td><input data-field="siteId" value="'+esc(tab.siteId||'')+'"'+disabled+'></td><td><label style="margin:0;color:var(--ink);font-size:13px"><input type="checkbox" data-field="requiresAuth" '+(tab.requiresAuth?'checked':'')+disabled+' style="width:auto"> Required</label></td><td><button type="button" class="danger" data-remove-tab="'+index+'"'+disabled+'>Remove</button></td></tr>'}
function syncTabs(){tabsDraft=[...document.querySelectorAll('#tabsBody tr')].map((row,index)=>{const get=f=>row.querySelector('[data-field="'+f+'"]');const url=(get('url')?.value||'').trim();const tab={id:(get('id')?.value||('tab'+(index+1))).trim(),title:(get('title')?.value||'').trim(),url,siteId:(get('siteId')?.value||'').trim(),requiresAuth:!!get('requiresAuth')?.checked};if(hasBraceVars(url))tab.urlTemplate=url;return tab})}
function renderTabs(){el('tabsBody').innerHTML=tabsDraft.map(tabRow).join('');el('tabsBody').querySelectorAll('input').forEach(i=>i.addEventListener('input',()=>{syncTabs();renderTabs();validateSetup()}));el('tabsBody').querySelectorAll('[data-remove-tab]').forEach(btn=>btn.onclick=()=>{syncTabs();tabsDraft.splice(Number(btn.dataset.removeTab),1);renderTabs();validateSetup()})}
function renderWritebacks(){el('writebackRows').innerHTML=writebackDraft.map((w,i)=>'<div class="writeback-row"><input data-wb-source="'+i+'" placeholder="captured output, e.g. confirmationUrl" value="'+esc(w.source||'')+'"><input data-wb-destination="'+i+'" placeholder="source field, e.g. record.confirmationUrl" value="'+esc(w.destination||'')+'"><button type="button" class="danger" data-wb-remove="'+i+'">Remove</button></div>').join('')||'<div class="mini">No writeback targets declared.</div>';el('writebackRows').querySelectorAll('input').forEach(input=>input.addEventListener('input',syncWritebacks));el('writebackRows').querySelectorAll('[data-wb-remove]').forEach(btn=>btn.onclick=()=>{syncWritebacks();writebackDraft.splice(Number(btn.dataset.wbRemove),1);renderWritebacks()})}
function syncWritebacks(){writebackDraft=writebackDraft.map((w,i)=>({id:w.id||'',source:document.querySelector('[data-wb-source="'+i+'"]')?.value.trim()||'',destination:document.querySelector('[data-wb-destination="'+i+'"]')?.value.trim()||'',required:!!w.required})).filter(w=>w.source||w.destination)}
function validateSetup(){syncTabs();const bad=tabsDraft.filter(t=>isBadUrl(t.url));let msg=bad.length?'Fix '+bad.length+' tab URL(s) before recording.':'Setup looks ready.';let cls=bad.length?'status bad':'status ok';if(isRecordingActive()){msg='Recording is active. Click Done Recording before editing setup.';cls='status warn'}else if(isImported()){msg='Workflow imported. Create a new recording session to edit setup.';cls='status warn'}el('setupValidation').textContent=msg;el('setupValidation').className=cls;const blocked=actionInFlight||bad.length>0||isRecordingActive()||isImported();el('startRecordingBtn').disabled=blocked;el('stopRecordingBtn').disabled=actionInFlight||!isRecordingActive();el('abandonRecordingBtn').disabled=actionInFlight||!isRecordingActive();el('saveSetupBtn').disabled=actionInFlight||isRecordingActive()||isImported();el('addTabBtn').disabled=actionInFlight||isRecordingActive()||isImported();return !bad.length&&!isRecordingActive()&&!isImported()}
function normalizeCompletionAction(action){return action===('write_outputs_to_'+'pan'+'cake')?'write_outputs_to_source_app':action}
function completionPolicy(){const action=normalizeCompletionAction(el('completionAction').value);return{action,notes:el('completionNotes').value.trim(),closeBrowser:action==='close_browser',requireApprovalBeforeSubmit:action!=='do_nothing'&&action!=='close_browser'}}
async function saveSetup(){if(isRecordingActive())throw new Error('Click Done Recording before saving setup.');syncTabs();syncWritebacks();const recordingSetup={...(currentRecording.recordingSetup||{}),authProfileId:el('authProfileId').value.trim(),tabs:tabsDraft};const payload={recordingSetup,callbackUrl:el('callbackUrl').value.trim(),fieldContractIntent:el('fieldContractIntent').value.trim(),completionPolicy:completionPolicy(),writebackTargets:writebackDraft};const data=await api('/api/recordings/'+encodeURIComponent(recordingSessionId)+'/setup',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});await load();return data}
function authProfilePayload(){const authProfileId=el('authProfileId').value.trim()||(currentRecording&&currentRecording.recordingSetup&&currentRecording.recordingSetup.authProfileId)||'';if(!authProfileId)throw new Error('Auth profile is required.');return{appId:currentRecording.appId||null,workflowId:currentRecording.workflowId||null,authProfileId}}
function describeAuthProfile(profile){const state=profile.locked?(profile.stale?'stale lock':'active lock'):'healthy';const age=profile.lockAgeMs==null?'unknown':Math.round(profile.lockAgeMs)+'ms';const owner=profile.lockOwner?JSON.stringify(profile.lockOwner):'unknown';return 'Auth profile '+profile.authProfileId+': '+state+'\\nPath: '+profile.userDataDir+'\\nOwner: '+owner+'\\nLock age: '+age+'\\nRecovery: '+(profile.recoveryAction||'none')}
function parseObservation(){const raw=el('observationInput').value.trim();if(!raw)return{};const parsed=JSON.parse(raw);return parsed.events?{events:parsed.events,observation:parsed.observation}:{observation:parsed}}
function payloadPaths(schema,prefix=''){const props=(schema&&schema.properties)||{};let out=[];for(const [key,value] of Object.entries(props)){const path=prefix?prefix+'.'+key:key;out.push({id:path});if(value&&value.type==='object')out=out.concat(payloadPaths(value,path));if(value&&value.type==='array'&&value.items&&value.items.type==='object')out=out.concat(payloadPaths(value.items,path+'[]'))}return out}
async function load(){const data=await api('/api/recordings/'+encodeURIComponent(recordingSessionId));const r=data.recording;const sourceLabel=sourceAppLabel(r);currentRecording=r;tabsDraft=((r.recordingSetup&&r.recordingSetup.tabs)||[]).map(t=>({...t}));writebackDraft=(r.writebackTargets||[]).map(w=>({...w}));el('status').textContent=r.status;el('status').className=r.status==='imported'?'status ok':r.status==='recording'?'status warn':'status';el('pageTitle').textContent=(r.workflowName||r.workflowId||'New automation');el('pageSubtitle').textContent=(r.appName||r.appId||'Calling app')+' / '+(r.workflowRefPreview||r.workflowId);el('app').textContent=(r.appName||r.appId||'App')+(r.appId?' / '+r.appId:'');el('workflow').textContent=(r.workflowName||r.workflowId||'Workflow')+(r.workflowId?' / '+r.workflowId:'')+(r.targetUrl?' -> '+r.targetUrl:'');el('sourceDataTitle').textContent='What info do I need to grab from '+sourceLabel+'?';el('sourceDataHint').textContent='Declare source fields and use them in tab URLs as {fieldId} or {{fieldId}}. Browsy resolves templates from the sample/source payload before launch and keeps final actions gated.';el('sourceFieldsTitle').textContent='Current '+sourceLabel+'-provided fields';el('authProfileId').value=(r.recordingSetup&&r.recordingSetup.authProfileId)||'';el('callbackUrl').value=r.callbackUrlTemplate||r.callbackUrl||'';el('fieldContractIntent').value=r.fieldContractIntent||'';el('completionAction').value=normalizeCompletionAction((r.completionPolicy&&r.completionPolicy.action)||'wait_for_human_submission');el('completionNotes').value=(r.completionPolicy&&r.completionPolicy.notes)||'';renderTabs();renderWritebacks();const schemaPaths=payloadPaths(r.payloadSchema);const samplePaths=flattenPayload(r.samplePayload||{});renderGroupedVariables(el('payloadFields'),[...schemaPaths,...samplePaths]);renderGroupedVariables(el('availableVariables'),[...(r.bindingHints||[]),...schemaPaths,...samplePaths]);renderPills(el('fileBindings'),r.fileBindings||[],x=>(x.binding||x.source||x.id)+' <- '+x.id);renderPills(el('expectedOutputs'),r.expectedOutputs||[],x=>x.id);renderPills(el('humanCheckpoints'),r.humanCheckpoints||[],x=>(x.id||'checkpoint')+(x.label?' - '+x.label:''));el('samplePayload').textContent=JSON.stringify(r.samplePayload||{},null,2);validateSetup()}
function showStep(n){step=Math.max(1,Math.min(5,n));document.querySelectorAll('.step').forEach(s=>s.classList.toggle('active',Number(s.dataset.step)===step));document.querySelectorAll('[data-nav]').forEach(b=>b.classList.toggle('active',Number(b.dataset.nav)===step));el('prevBtn').disabled=step===1;el('nextBtn').textContent=step===5?'Review':'Next'}
async function runAction(label,fn){if(actionInFlight)return;actionInFlight=true;const busyText=label+'...';el('actionResult').className='result status warn';el('actionResult').textContent=busyText;el('contractOutput').textContent='{}';validateSetup();try{const result=await fn();if(el('actionResult').textContent===busyText){el('actionResult').className='result status ok';el('actionResult').textContent=''}return result}catch(err){let msg='Error: '+(err.message||String(err));if(err.data&&err.data.code==='auth_profile_locked'){const profile=err.data.authProfile||err.data.profileLock||{};const recovery=err.data.profileLockRecovery||err.data.recovery||{};msg+='\\n\\nAuth lock details:\\n'+describeAuthProfile(profile)+'\\nRecovery attempted: '+(recovery.recoveryAction||'none')+'\\nUse Release Stale Lock if the lock is stale. If it is active, close the open profile browser window and start again.'}el('actionResult').className='result status bad';el('actionResult').textContent=msg;el('contractOutput').textContent=JSON.stringify({error:err.message||String(err),details:err.data||null},null,2)}finally{actionInFlight=false;validateSetup()}}
document.querySelectorAll('[data-nav]').forEach(btn=>btn.onclick=()=>showStep(Number(btn.dataset.nav)));
el('prevBtn').onclick=()=>showStep(step-1);
el('nextBtn').onclick=()=>showStep(step+1);
el('addTabBtn').onclick=()=>{syncTabs();tabsDraft.push({id:'tab'+(tabsDraft.length+1),title:'',url:'',siteId:'',requiresAuth:false});renderTabs();validateSetup()};
el('addWritebackBtn').onclick=()=>{syncWritebacks();writebackDraft.push({source:'',destination:''});renderWritebacks()};
el('saveSetupBtn').onclick=()=>runAction('Saving setup',async()=>{await saveSetup();el('setupValidation').textContent='Saved setup.'});
el('checkAuthBtn').onclick=()=>runAction('Checking auth profile',async()=>{const data=await api('/api/auth-profiles/inspect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(authProfilePayload())});el('actionResult').className=data.profile.locked?'result status bad':'result status ok';el('actionResult').textContent=describeAuthProfile(data.profile);return data});
el('releaseStaleLockBtn').onclick=()=>runAction('Releasing stale auth lock',async()=>{const data=await api('/api/auth-profiles/release-stale-lock',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(authProfilePayload())});const lockedAfter=data.recovery.lockedAfter??!!(data.recovery.lock&&data.recovery.lock.locked);el('actionResult').className='result status ok';el('actionResult').textContent='Stale lock release result: '+(data.recovery.recoveryAction||'none')+'. Locked after release: '+lockedAfter;return data});
el('startRecordingBtn').onclick=()=>runAction('Starting recording',async()=>{if(!validateSetup())throw new Error('Fix tab URLs before starting.');await api('/api/health');await saveSetup();const data=await api('/api/recordings/'+encodeURIComponent(recordingSessionId)+'/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})});el('actionResult').className='result status ok';el('actionResult').textContent='Recording started. Mode: '+((data.launch&&data.launch.mode)||'unknown')+'. Use the opened tabs, then click Done Recording.';await load();return data});
el('stopRecordingBtn').onclick=()=>runAction('Stopping recording',async()=>{const payload=parseObservation();const data=await api('/api/recordings/'+encodeURIComponent(recordingSessionId)+'/stop',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});el('actionResult').className='result status ok';el('actionResult').textContent='Recording stopped. Events: '+((data.runtime&&data.runtime.eventCount)||0)+'. Review and import when ready.';await load();showStep(5);return data});
el('abandonRecordingBtn').onclick=()=>runAction('Abandoning recording',async()=>{const data=await api('/api/recordings/'+encodeURIComponent(recordingSessionId)+'/abandon',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reason:'abandoned from recording page'})});el('actionResult').className='result status ok';el('actionResult').textContent='Recording abandoned. Browser closed and auth profile cleanup ran.';await load();return data});
el('importWorkflowBtn').onclick=()=>runAction('Importing workflow',async()=>{await saveSetup();const data=await api('/api/recordings/'+encodeURIComponent(recordingSessionId)+'/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({overwrite:true,autoRegisterApp:true})});el('contractOutput').textContent=JSON.stringify(data.contract||data.recording,null,2);el('actionResult').className='result status ok';el('actionResult').textContent='Imported workflowRef: '+data.workflowRef;await load();return data});
el('viewContractBtn').onclick=()=>runAction('Loading contract',async()=>{const data=await api('/api/recordings/'+encodeURIComponent(recordingSessionId)+'/contract');el('contractOutput').textContent=JSON.stringify(data.contract,null,2);return data});
load().catch(err=>{el('setupValidation').className='status bad';el('setupValidation').textContent=err.message});
</script>
</body>
</html>`;
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}
