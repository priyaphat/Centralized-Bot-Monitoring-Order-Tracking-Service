const state = { summary: {}, bots: [], orders: [], deployTargets: new Set() };
const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' })[char]);

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || body.error || `HTTP ${response.status}`);
  return body;
}
function toast(message) { const node=$('#toast'); node.textContent=message; node.classList.add('show'); setTimeout(()=>node.classList.remove('show'),2500); }
function fmtTime(value) { return value ? new Date(value).toLocaleString('th-TH') : '-'; }

function render() {
  $('#summary').innerHTML = [
    ['เครื่องออนไลน์', state.summary.online || 0], ['บอทเปิดรับงาน', state.summary.active || 0],
    ['รออยู่ (Standby)', state.summary.standby || 0], ['กำลังทำงาน', state.summary.in_progress || 0]
  ].map(([label,value])=>`<div class="metric"><strong>${value}</strong><span>${label}</span></div>`).join('');
  $('#system-state').textContent = state.summary.systemEnabled ? 'ทั้งระบบ: เปิด' : 'ทั้งระบบ: ปิด';
  $('#toggle-system').textContent = state.summary.systemEnabled ? 'ปิดทั้งระบบ' : 'เปิดทั้งระบบ';
  $('#toggle-system').className = state.summary.systemEnabled ? 'danger' : '';
  $('#bots').innerHTML = state.bots.map((bot)=>`<article class="bot-card" data-id="${escapeHtml(bot.id)}">
    <div class="bot-head"><div><b>${escapeHtml(bot.name)}</b><div class="label">${escapeHtml(bot.device_name)}</div></div><div class="bot-badges"><label title="เลือกเครื่องนี้สำหรับ deployment"><input class="deploy-target" type="checkbox" value="${escapeHtml(bot.id)}" ${state.deployTargets.has(bot.id)?'checked':''}> อัปเดต</label><span class="status ${bot.status}">${bot.status}</span></div></div>
    <div class="bot-state">Bot state: <b>${bot.status==='online'?(bot.accepting_orders?'active':'standby'):'offline'}</b></div>
    <div class="stats"><div class="stat">CPU<b>${bot.cpu_percent}%</b></div><div class="stat">Memory<b>${bot.memory_percent}%</b></div><div class="stat">Heartbeat<b>${fmtTime(bot.last_heartbeat)}</b></div><div class="stat">งานล่าสุด Done/Failed<b>${escapeHtml(bot.last_job ? `${bot.last_job.external_order_id}: ${bot.last_job.status}` : '-')}</b></div></div>
    <div class="actions"><button data-command="start">เปิด</button><button class="danger" data-command="stop">ปิด</button><button class="secondary" data-command="restart">Restart</button><button class="secondary" data-detail>Log / Metrics</button></div>
  </article>`).join('') || '<p>ยังไม่มีข้อมูลบอท กดรีเฟรชหลังเปิด simulator</p>';
  $('#orders').innerHTML = state.orders.map((order)=>`<tr><td>${order.id}</td><td>${escapeHtml(order.external_order_id)}</td><td><span class="status ${order.status}">${order.status}</span></td><td>${escapeHtml(order.assigned_bot_id || '-')}</td><td>${transitionControl(order)}</td></tr>`).join('');
}
function transitionControl(order) {
  const next = {pending_payment:['queued','cancelled'],queued:['in_progress','failed','cancelled'],in_progress:['completed','delayed','failed'],delayed:['queued','in_progress','failed','cancelled'],failed:['queued']}[order.status] || [];
  if (!next.length) return '-';
  const options = next.map((status)=>`<option value="${status}">${status}</option>`).join('');
  const dispatch = ['queued','delayed'].includes(order.status) ? `<button data-dispatch="${order.id}">Dispatch</button>` : '';
  return `<div class="order-actions"><select data-order="${order.id}"><option value="">เลือก...</option>${options}</select>${dispatch}</div>`;
}
async function refresh(sync = false) {
  const [summary,bots,orders] = await Promise.all([api('/api/summary'),api(`/api/bots${sync?'?sync=true':''}`),api('/api/orders')]);
  Object.assign(state,{summary,bots,orders}); render();
}

$('#toggle-system').addEventListener('click', async()=>{ try{await api('/api/system/enabled',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:!state.summary.systemEnabled})});await refresh();}catch(e){toast(e.message);} });
$('#refresh').addEventListener('click',()=>refresh(true).catch((e)=>toast(e.message)));
$('#bots').addEventListener('click',async(event)=>{const button=event.target.closest('[data-command]');if(!button)return;const bot=button.closest('[data-id]').dataset.id;try{await api(`/api/bots/${bot}/commands`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({command:button.dataset.command})});toast('ส่งคำสั่งแล้ว');await refresh();}catch(e){toast(e.message);}});
$('#bots').addEventListener('click',async(event)=>{const button=event.target.closest('[data-detail]');if(!button)return;const id=button.closest('[data-id]').dataset.id;const bot=state.bots.find((item)=>item.id===id);try{const commands=await api(`/api/bots/${id}/commands`);$('#detail-title').textContent=`${bot.name} - Log / Metrics`;$('#detail-body').innerHTML=`<div class="detail-metrics"><div class="stat">CPU<b>${bot.cpu_percent}%</b></div><div class="stat">Memory<b>${bot.memory_percent}%</b></div><div class="stat">Uptime<b>${bot.uptime_seconds}s</b></div><div class="stat">Heartbeat<b>${fmtTime(bot.last_heartbeat)}</b></div></div><h3>Command history</h3>${commands.length?`<table><thead><tr><th>เวลา</th><th>คำสั่ง</th><th>สถานะ</th><th>ผู้สั่ง</th></tr></thead><tbody>${commands.map((item)=>`<tr><td>${fmtTime(item.created_at)}</td><td>${escapeHtml(item.command)}</td><td><span class="status ${item.status}">${item.status}</span></td><td>${escapeHtml(item.requested_by)}</td></tr>`).join('')}</tbody></table>`:'<p>ยังไม่มีประวัติคำสั่ง</p>'}`;$('#bot-detail').showModal();}catch(e){toast(e.message);}});
$('#bots').addEventListener('change',(event)=>{const checkbox=event.target.closest('.deploy-target');if(!checkbox)return;if(checkbox.checked)state.deployTargets.add(checkbox.value);else state.deployTargets.delete(checkbox.value);});
$('#close-detail').addEventListener('click',()=>$('#bot-detail').close());
$('#orders').addEventListener('change',async(event)=>{const select=event.target.closest('[data-order]');if(!select?.value)return;try{if(select.value==='in_progress'){const order=await api(`/api/orders/${select.dataset.order}/dispatch`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({})});toast(`ส่งงานให้ ${order.assigned_bot_id} แล้ว`);}else{await api(`/api/orders/${select.dataset.order}/transition`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({status:select.value})});}await refresh();}catch(e){toast(e.message);select.value='';}});
$('#orders').addEventListener('click',async(event)=>{const button=event.target.closest('[data-dispatch]');if(!button)return;try{const order=await api(`/api/orders/${button.dataset.dispatch}/dispatch`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({})});toast(`ส่งงานให้ ${order.assigned_bot_id} แล้ว`);await refresh();}catch(e){toast(e.message);}});
$('#order-form').addEventListener('submit',async(event)=>{event.preventDefault();const form=new FormData(event.target);try{await api('/api/orders',{method:'POST',headers:{'content-type':'application/json','Idempotency-Key':crypto.randomUUID()},body:JSON.stringify(Object.fromEntries(form))});event.target.reset();await refresh();}catch(e){toast(e.message);}});
$('#deploy-form').addEventListener('submit',async(event)=>{event.preventDefault();const form=new FormData(event.target);const targets=[...state.deployTargets];form.set('targetBotIds',JSON.stringify(targets));try{await api('/api/deployments',{method:'POST',body:form});event.target.reset();state.deployTargets.clear();toast(targets.length?`อัปเดต ${targets.length} เครื่องสำเร็จ`:'อัปเดตทุกเครื่องสำเร็จ');await refresh();}catch(e){toast(e.message);}});

const ws = new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/ws`);
ws.onopen=()=>{$('#connection').textContent='● Real-time connected';};
ws.onclose=()=>{$('#connection').textContent='○ Disconnected';};
ws.onmessage=()=>{
  const active=document.activeElement;
  if(active?.matches('select,input,textarea')) return;
  refresh().catch(()=>{});
};
refresh(true).catch((e)=>toast(e.message));
