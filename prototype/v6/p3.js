/* ============ UI helpers ============ */
let view={r:'home',p:{}},stack=[],draft=null,sheetCtx=null;
const ic=n=>`<svg class="ic"><use href="#i-${n}"/></svg>`;
const num=v=>{const n=parseLen(v);return Number.isFinite(n)?String(+n.toFixed(3)):''};
const unitTxt=it=>unitOf(it)==='in'?t('u_in'):t('u_mm');
const shapeName=s=>t('sh_'+s);
const famName=f=>t('fam_'+f);
const roleName=r=>t('role_'+r);
const billChip=b=>b?`<span class="chip c-${b}">${b==='pakka'?t('pakka'):t('kacha')}</span>`:'';
const statusChip=s=>{const c={estimate:'c-blue',accepted:'c-amber',weighed:'c-blue',done:'c-ok'}[s];return c?`<span class="chip ${c}">${t('st_'+s)}</span>`:''};
function go(r,p={},replace=false){if(!replace)stack.push(view);view={r,p};render();window.scrollTo(0,0)}
function back(){view=stack.pop()||{r:'home',p:{}};render()}
function toast(m){const el=$('#toast');el.textContent=m;el.style.display='block';clearTimeout(toast.t);toast.t=setTimeout(()=>el.style.display='none',2600)}
function openSheet(title,body,foot=''){$('#sheet').className='open';$('#sheet').innerHTML=`<div class="scrim" data-act="closeSheet"></div><div class="pane" role="dialog" aria-label="${esc(title)}"><div class="sh"><h2>${title}</h2><button class="x" data-act="closeSheet" aria-label="${t('close')}">${ic('x')}</button></div><div class="sb">${body}</div>${foot?`<div class="sf">${foot}</div>`:''}</div>`}
function closeSheet(){$('#sheet').className='';$('#sheet').innerHTML='';sheetCtx=null}
function bar(title,o={}){
  const home=view.r==='home';
  return `<header class="bar">${home?'':`<button class="ib" data-act="back" aria-label="${t('back')}">${ic('back')}</button>`}${o.avatar?`<div class="avatar">${esc(me().name[0])}</div>`:''}<div class="ttl"><h1>${title}</h1>${o.sub?`<div class="sub">${o.sub}</div>`:''}</div>${o.right||''}<button class="lang" data-act="lang" aria-label="Language">${LANG_LABEL[db.lang]}</button></header>`;
}
const dimTxt=it=>{const d=it.d.map(num);const s=it.shape;return s==='square'?`${d[0]} × ${d[0]}`:s==='round'?`Ø${d[0]}`:s==='hex'?`${t('hexaf')} ${d[0]}`:s==='plate'?`${d[0]} × ${d[1]} × ${d[2]}`:`${d[0]} × ${d[1]}`};
const itemDesc=it=>`${esc(it.grade)} · ${shapeName(it.shape)} ${dimTxt(it)} ${unitTxt(it)}`;
const itemRows=it=>(it.rows&&it.rows.length)?it.rows:[{len:it.len,pcs:it.pcs,cuts:it.cuts}];
const totalPcs=it=>itemRows(it).reduce((a,r)=>a+(Math.floor(Number(r.pcs))||0),0);
/* one line: single length shows the old "cut length" phrasing, several lengths list each length × its piece count */
function itemDescLen(it){
  const sh=SHAPES[it.shape];if(!sh.len)return itemDesc(it);
  const rows=itemRows(it);
  if(rows.length<=1)return `${itemDesc(it)}, ${t('cut_len')} ${num(rows[0]?rows[0].len:'')} ${unitTxt(it)}`;
  return `${itemDesc(it)} — ${rows.map(r=>`${num(r.len)}${unitTxt(it)}-${Math.floor(Number(r.pcs))||0}${t('pcs')}`).join(', ')}`;
}
function areaTxt(c,it){const a=c.sides.map(s=>s.inch);const s=it.shape;
  const f=s==='round'?`π/4 × ${a[0]}²`:s==='hex'?`0.866 × ${a[0]}²`:s==='square'?`${a[0]} × ${a[0]}`:`${a[0]} × ${a[1]}`;return `${f} = ${fmt(c.area,2)} ${t('sqin')}`}
function calcHtml(it,mode,showMoney=true){
  const c=calcItem(it,mode);
  if(!c)return `<div class="small muted" style="padding-top:10px">${t('fill_hint')}</div>`;
  const sides=c.sides.map(s=>`${fmt(s.mm,s.mm%1?1:0)} mm = ${fmt(s.raw,2)} in → <b>${s.inch} in</b>`).join('<br>');
  let h=`<div class="ln"><span>${t('est_weight')}</span><b class="mono">${kg(c.est)}</b></div>`;
  if(c.useAct)h+=`<div class="ln"><span>${t('actual_weight')}</span><b class="mono">${kg(c.weight)}</b></div>`;
  if(showMoney){
    h+=`<div class="ln"><span>${t('material')}: ${fmt(c.weight,2)} kg × ₹${fmt(c.rate,2)}/kg</span><b class="mono">${money2(c.mat)}</b></div>`;
    h+=`<div class="ln"><span>${t('cutting')}: ${sides}<br>${areaTxt(c,it)} × ₹${fmt(c.cr,2)} × ${c.cuts} ${t('cuts_word')}</span><b class="mono">${money2(c.cut)}</b></div>`;
    h+=`<div class="ln big"><span>${t('item_total')}</span><b class="mono">${money2(c.total)}</b></div>`;
  }
  return h;
}
function totalsHtml(o,mode,bill){
  const b=bill!==undefined?bill:o.bill,T=orderTotals(o,mode,b);
  let h=`<div class="ln"><span>${t('material')}</span><b class="mono">${money2(T.mat)}</b></div><div class="ln"><span>${t('cutting')}</span><b class="mono">${money2(T.cut)}</b></div>`;
  if(b==='kacha')h+=`<div class="ln"><span>${t('local_line',T.pct)}</span><b class="mono">${money2(T.adj)}</b></div>`;
  if(b==='pakka')h+=`<div class="ln"><span>${t('gst_line',T.pct)}</span><b class="mono">${money2(T.gst)}</b></div>`;
  return h+`<div class="ln big"><span>${t('total')}</span><b class="mono">${money2(T.total)}</b></div>`;
}
/* both bill options side by side, for quoting before the bill type is known */
function quoteHtml(o,mode){
  const g=orderTotals(o,mode,'pakka'),k=orderTotals(o,mode,'kacha');
  return `<div class="quote"><div><small>${t('quote_gst')}</small><b class="mono">${money(g.total)}</b></div>${can('kacha')?`<div><small>${t('quote_none')}</small><b class="mono">${money(k.total)}</b></div>`:''}</div>`;
}
const custOf=id=>db.cust.find(c=>c.id===id)||{name:'—',phone:''};
const waLink=(phone,text)=>{let d=String(phone||'').replace(/\D/g,'');if(d.length===10)d='91'+d;return `https://wa.me/${d}?text=${encodeURIComponent(text)}`};

/* ============ screens ============ */
const R={};
function render(){
  const f=R[view.r];$('#app').innerHTML=f?f(view.p):'';
  if(view.r==='guide'&&view.p.focus){view.p.focus=false;const el=$('#gq');if(el)el.focus()}
}
R.home=()=>{
  const s=summaryToday(),kh=khataList().reduce((a,x)=>a+x.l.due,0),tw=visOrders().filter(o=>o.status==='accepted'||o.status==='weighed').length;
  const T=[];
  if(can('new'))T.push(`<button class="tile t-amber" data-act="newOrder">${ic('plus')}<span><b>${t('tile_new')}</b><small>${t('tile_new_s')}</small></span></button>`);
  if(can('weigh')||can('money'))T.push(`<button class="tile t-blue" data-act="go" data-r="weighList">${tw?`<span class="badge">${tw}</span>`:''}${ic('scale')}<span><b>${t('tile_weigh')}</b><small>${tw?t('n_waiting',tw):t('none_waiting')}</small></span></button>`);
  if(can('khata'))T.push(`<button class="tile t-green" data-act="go" data-r="khata">${ic('book')}<span><b>${t('tile_khata')}</b><small>${money(kh)} ${t('to_receive')}</small></span></button>`);
  if(can('today'))T.push(`<button class="tile t-navy" data-act="go" data-r="summary">${ic('chart')}<span><b>${t('tile_today')}</b><small>${can('money')?money(s.total)+' '+t('sales_word'):t('n_orders',s.n)}</small></span></button>`);
  if(can('orders'))T.push(`<button class="tile t-plain" data-act="go" data-r="orders">${ic('list')}<span><b>${t('tile_orders')}</b><small class="muted">${t('n_slips',visOrders().length)}</small></span></button>`);
  if(can('rates'))T.push(`<button class="tile t-plain" data-act="go" data-r="rates">${ic('tag')}<span><b>${t('tile_rates')}</b><small class="muted">${t('tile_rates_s')}</small></span></button>`);
  if(can('people'))T.push(`<button class="tile t-plain" data-act="go" data-r="people">${ic('users')}<span><b>${t('tile_people')}</b><small class="muted">${t('tile_people_s')}</small></span></button>`);
  if(can('settings'))T.push(`<button class="tile t-plain" data-act="go" data-r="settings">${ic('gear')}<span><b>${t('tile_settings')}</b><small class="muted">${t('tile_settings_s')}</small></span></button>`);
  const recent=[...visOrders()].sort((a,b)=>b.id-a.id).slice(0,4);
  return bar(`${t('hello')}, ${esc(me().name)}`,{avatar:true,sub:`${roleName(me().role)} · ${dfmt(new Date().toISOString(),{weekday:'short',day:'numeric',month:'short'})}`})+
  `<div class="proto">${t('proto')}</div><div class="body">
   <label class="f"><span>${t('viewing_as')}</span><select class="in" data-chg="me">${db.users.map(u=>`<option value="${u.id}" ${u.id===db.me?'selected':''}>${esc(u.name)} — ${roleName(u.role)}</option>`).join('')}</select></label>
   ${'<button class="gsearch" data-act="openGuide">'+ic('search')+'<span>'+t('home_search')+'</span></button>'}
   <div class="grid">${T.join('')}</div>
   ${recent.length&&can('orders')?`<div class="h2">${t('recent')}</div><div class="card flush">${recent.map(o=>`<button class="li" data-act="go" data-r="order" data-id="${o.id}"><span class="no">#${o.slipNo}</span><span class="nm"><b>${esc(custOf(o.cust).name)}</b></span>${statusChip(o.status)}</button>`).join('')}</div>`:''}
   <div class="info">${t('home_note')}</div></div>`;
};

const localDateStr=iso=>{const d=new Date(iso);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')};
function inDateFilter(o,r){
  if(!r||!r.mode||r.mode==='all')return true;
  const d=localDateStr(o.at);
  if(r.mode==='date')return r.date?d===r.date:true;
  if(r.mode==='month')return r.month?d.slice(0,7)===r.month:true;
  if(r.mode==='range'){if(r.from&&d<r.from)return false;if(r.to&&d>r.to)return false;return true}
  return true;
}
const billOk=(o,bf)=>!bf||bf==='all'?true:bf==='none'?!o.bill:o.bill===bf;
function rangeCard(r){
  const modes=[['all','rg_all'],['date','rg_date'],['month','rg_month'],['range','rg_range']];
  const pick=(k,type,val,extra='')=>`<input class="in" type="${type}" data-inp="${k}" value="${esc(val||'')}" ${extra}>`;
  let picker='';
  if(r.mode==='date')picker=`<div style="margin-top:10px">${pick('rgDate','date',r.date)}</div>`;
  else if(r.mode==='month')picker=`<div style="margin-top:10px">${pick('rgMonth','month',r.month)}</div>`;
  else if(r.mode==='range')picker=`<div class="fg" style="margin-top:10px"><label class="f"><span>${t('rg_from')}</span>${pick('rgFrom','date',r.from)}</label><label class="f"><span>${t('rg_to')}</span>${pick('rgTo','date',r.to)}</label></div>`;
  return `<div class="card"><div class="xs muted" style="font-weight:600;margin-bottom:5px">${t('rg_title')}</div>
   <div class="seg wrap">${modes.map(([k,l])=>`<button class="${(r.mode||'all')===k?'on':''}" data-act="ordRange" data-k="${k}">${t(l)}</button>`).join('')}</div>${picker}</div>`;
}
R.orders=p=>{
  const f=p.f||'all';const now=new Date().toISOString();
  const range=p.range||{mode:'all'},bill=p.bill||'all';
  let L=[...visOrders()].sort((a,b)=>b.id-a.id);
  if(f==='toweigh')L=L.filter(o=>o.status==='accepted');else if(f==='ready')L=L.filter(o=>o.status==='weighed');else if(f==='done')L=L.filter(o=>o.status==='done');else if(f==='estimate')L=L.filter(o=>o.status==='estimate');else if(f==='today')L=L.filter(o=>sameDay(o.at,now));
  L=L.filter(o=>inDateFilter(o,range)&&billOk(o,bill));
  const tabs=[['all','f_all'],['today','f_today'],['estimate','st_estimate'],['toweigh','st_accepted'],['ready','st_weighed'],['done','st_done']];
  const billChips=[['all','bf_all'],['pakka','bf_pakka'],['kacha','bf_kacha'],['none','bf_none']];
  return bar(t('tile_orders'))+`<div class="body"><div class="tabs">${tabs.map(([k,l])=>`<button class="pill ${f===k?'on':''}" data-act="ordFilter" data-f="${k}">${t(l)}</button>`).join('')}</div>
  ${rangeCard(range)}
  <div class="card"><div class="xs muted" style="font-weight:600;margin-bottom:5px">${t('bf_title')}</div><div class="tabs">${billChips.map(([k,l])=>`<button class="pill ${bill===k?'on':''}" data-act="ordBill" data-k="${k}">${t(l)}</button>`).join('')}</div></div>
  <div class="card flush">${L.length?L.map(o=>`<button class="li" data-act="go" data-r="order" data-id="${o.id}"><span class="no">#${o.slipNo}</span><span class="nm"><b>${esc(custOf(o.cust).name)}</b><span class="xs muted">${dfmt(o.at)}${o.bill?' · '+billChip(o.bill):''}</span></span><span class="amt">${can('money')?`<b class="mono">${money(finalTotal(o).total)}</b>`:''}${statusChip(o.status)}</span></button>`).join(''):`<div class="li muted">${t('none')}</div>`}</div></div>`;
};

/* ---- new order / draft ---- */
function newItem(cust){const it={matId:'EN8',grade:'EN8',unit:db.set.unit||'mm',shape:'square',d:[''],rows:[{len:'',pcs:'',cuts:''}],rate:0,special:false,cutRate:0,density:0,aw:null};applyMat(it,'EN8',cust);return it}
function applyMat(it,id,cust){const m=matById(id);if(!m)return;const rr=resolveRate(id,cust);it.matId=id;it.grade=id;it.rate=rr.rate;it.special=rr.special;it.cutRate=m.cut;it.density=densOf(m)||0}
function startDraft(o){
  if(o){draft={id:o.id,cust:o.cust,items:JSON.parse(JSON.stringify(o.items)),adv:{amt:'',mode:'Cash',note:''}}}
  else draft={id:null,cust:null,items:[],adv:{amt:'',mode:'Cash',note:''}};
  if(!draft.items.length)draft.items.push(newItem(draft.cust));
}
/* "last time you sold this" hint under the rate boxes */
function hintHtml(it,i){
  if(!can('money')||!draft)return '';
  const L=lastSold(draft.cust,it.matId,draft.id),h=L.mine||L.any;
  if(!h)return `<div class="hint"><span>${t('never_sold')}</span></div>`;
  const d=dfmt(h.at,{day:'numeric',month:'short'});
  const line=L.mine?t('last_cust',esc(custOf(h.cust).name),fmt(h.rate,2),fmt(h.cut,2),d,h.id):t('last_any',esc(custOf(h.cust).name),fmt(h.rate,2),d);
  const cur=Number(it.rate)||0,diff=r2(cur-h.rate);
  const chip=diff>0?`<span class="chip c-amber">${t('diff_up',fmt(diff,2))}</span>`:diff<0?`<span class="chip c-blue">${t('diff_down',fmt(-diff,2))}</span>`:`<span class="chip c-ok">${t('diff_same')}</span>`;
  const same=Number(it.rate)===h.rate&&(Number(it.cutRate)||0)===h.cut;
  return `<div class="hint"><span>${line}</span><div class="row">${chip}${same?'':`<button class="link" data-act="useLast" data-i="${i}">${t('use_last')}</button>`}</div></div>`;
}
/* one "length + pieces + cuts" row inside an item; a plain shape (plate) has no length field, just one implicit row */
function rowRow(it,i,r,j,removable){
  const sh=SHAPES[it.shape];
  return `<div class="rowline">${sh.len?`<label class="f"><span>${t('cut_len')}</span><span class="unit"><input class="in" inputmode="decimal" data-inp="rlen" data-i="${i}" data-j="${j}" value="${esc(r.len)}" placeholder="0"><i>${unitTxt(it)}</i></span></label>`:''}
   <label class="f"><span>${t('pieces')}</span><input class="in" inputmode="numeric" data-inp="rpcs" data-i="${i}" data-j="${j}" value="${esc(r.pcs)}" placeholder="0"></label>
   <label class="f"><span>${t('cuts')}</span><input class="in" inputmode="numeric" data-inp="rcuts" data-i="${i}" data-j="${j}" value="${esc(r.cuts)}" placeholder="${esc(r.pcs||'auto')}"></label>
   ${removable?`<button class="link rmrow" data-act="rmRow" data-i="${i}" data-j="${j}" aria-label="${t('remove')}">${ic('trash')}</button>`:''}</div>`;
}
function itemCard(it,i){
  const m=matById(it.matId),sh=SHAPES[it.shape],money_=can('money'),u=unitOf(it);
  const dims=sh.dims.map((k,j)=>`<label class="f"><span>${t('d_'+k)}</span><span class="unit"><input class="in" inputmode="decimal" data-inp="dim" data-i="${i}" data-j="${j}" value="${esc(it.d[j]??'')}" placeholder="0"><i>${unitTxt(it)}</i></span></label>`).join('');
  const rows=itemRows(it);
  const rowsHtml=rows.map((r,j)=>rowRow(it,i,r,j,sh.len&&rows.length>1)).join('')+(sh.len?`<button class="dash sm" data-act="addRow" data-i="${i}">${ic('plus')}${t('add_length')}</button>`:'');
  return `<div class="card item" id="it${i}"><div class="hd"><span class="num">${i+1}</span><b style="font-size:17px">${t('item')}</b><span class="sp"></span>${draft.items.length>1?`<button class="link" data-act="rmItem" data-i="${i}" aria-label="${t('remove')}">${ic('trash')}</button>`:''}</div>
   <div class="xs muted" style="font-weight:600;margin-bottom:5px">${t('grade')}</div>
   <div class="matbtn"><button style="flex:1;text-align:left" data-act="pickMat" data-i="${i}"><b>${esc(it.grade)}</b><span class="fam">${m?famName(m.family):''} · ${t('tap_change')}</span></button><button class="infob" data-act="info" data-mat="${esc(it.matId)}" data-i="${i}" aria-label="${t('info')}">i</button></div>
   <div class="xs muted" style="font-weight:600;margin:12px 0 5px">${t('shape')}</div>
   <div class="tabs">${SHAPE_IDS.map(s=>`<button class="pill ${it.shape===s?'on':''}" data-act="setShape" data-i="${i}" data-s="${s}">${shapeName(s)}</button>`).join('')}</div>
   <div class="row" style="margin:14px 0 0;justify-content:space-between"><span class="xs muted" style="font-weight:600">${t('unit_label')}</span><div class="seg mini"><button class="${u==='mm'?'on':''}" data-act="setUnit" data-i="${i}" data-u="mm">${t('u_mm')}</button><button class="${u==='in'?'on':''}" data-act="setUnit" data-i="${i}" data-u="in">${t('u_in')}</button></div></div>
   <div class="fg" style="margin-top:10px">${dims}</div>
   ${sh.len?`<div class="xs muted" style="font-weight:600;margin:12px 0 5px">${t('lengths_title')}</div>`:''}
   <div id="rows${i}">${rowsHtml}</div>
   ${money_?`<div class="fg" style="margin-top:10px"><label class="f"><span>${t('rate_kg')} ${it.special?`<span class="chip c-ok">${t('special')}</span>`:''}</span><span class="unit"><input class="in" inputmode="decimal" data-inp="rate" data-i="${i}" value="${esc(it.rate)}"><i>₹/kg</i></span></label>
    <label class="f"><span>${t('cut_rate')}</span><span class="unit"><input class="in" inputmode="decimal" data-inp="crate" data-i="${i}" value="${esc(it.cutRate)}"><i>₹</i></span></label></div>`:''}
   <div id="hint${i}">${hintHtml(it,i)}</div>
   <div class="calc" id="calc${i}">${calcHtml(it,'est',money_)}</div></div>`;
}
function dockTotals(){
  const o={items:draft.items},T=orderTotals(o,'est');
  return `<div class="tot"><span>${t('est_total')}</span><b class="mono">${T.ok?money2(T.base):'—'}</b></div>${T.ok&&can('money')?quoteHtml(o,'est'):''}`;
}
function advCard(){
  if(!can('money'))return '';
  return `<div class="card"><div class="row"><b style="font-size:17px">${t('adv_title')}</b></div><div class="small muted" style="margin:2px 0 10px">${t('adv_note')}</div>
   <label class="f"><span>${t('adv_amt')}</span><span class="unit"><input class="in" id="advAmt" inputmode="decimal" data-inp="advAmt" value="${esc(draft.adv.amt)}" placeholder="0"><i>₹</i></span></label>
   <div class="xs muted" style="font-weight:600;margin:10px 0 5px">${t('pay_via')}</div><div class="seg" id="advModeSeg">${MODES.map(m=>`<button class="${draft.adv.mode===m?'on':''}" data-act="advMode" data-m="${m}">${m}</button>`).join('')}</div>
   <label class="f" style="margin-top:10px"><span>${t('pay_note')}</span><input class="in" data-inp="advNote" value="${esc(draft.adv.note||'')}" placeholder="${t('pay_note_ph')}"></label></div>`;
}
R.newOrder=()=>{
  const c=draft.cust?custOf(draft.cust):null;
  const existing=draft.id&&db.orders.find(x=>x.id===draft.id);
  return bar(draft.id?`${t('edit_order')} #${existing?existing.slipNo:draft.id}`:t('tile_new'),{right:`<div class="small" style="text-align:right;opacity:.9">${t('slip_no')}<br><b>#${existing?existing.slipNo:peekSlipNo()}</b></div>`})+
  `<div class="body">
   <button class="card row" style="width:100%;text-align:left" data-act="pickCust"><span class="sp"><b style="font-size:18px">${c?esc(c.name):t('choose_customer')}</b>${c?`<div class="small muted">${esc(c.phone)||t('no_phone')}</div>`:''}</span><span class="link">${c?t('change'):t('choose')}</span></button>
   ${draft.items.map(itemCard).join('')}
   <button class="dash" data-act="addItem">${ic('plus')}${t('add_item')}</button>
   ${advCard()}
   <div class="info">${t('bill_pending')}</div></div>
   <div class="dock"><div id="dockTot">${dockTotals()}</div><div class="acts"><button class="btn b-out sm" data-act="saveOrder" data-a="0">${t('save_est')}</button><button class="btn b-amber" data-act="saveOrder" data-a="1">${t('accept')}</button></div></div>`;
};
function refreshDraft(i){
  if(i!=null){const el=$('#calc'+i);if(el)el.innerHTML=calcHtml(draft.items[i],'est',can('money'));const h=$('#hint'+i);if(h)h.innerHTML=hintHtml(draft.items[i],i)}
  const d=$('#dockTot');if(d)d.innerHTML=dockTotals();
}
function saveOrder(accept){
  if(!draft.cust){toast(t('need_cust'));return}
  const bad=draft.items.findIndex(it=>!calcItem(it,'est'));
  if(bad>=0){toast(t('need_item',bad+1));return}
  const now=new Date().toISOString(),by=me().name;
  let o=draft.id&&db.orders.find(x=>x.id===draft.id);
  if(o){o.cust=draft.cust;o.items=JSON.parse(JSON.stringify(draft.items));o.log.push({at:now,by,k:'edited'})}
  else{const nid=db.next++;o={id:nid,slipNo:nextSlipNo(nid),cust:draft.cust,bill:null,at:now,status:'estimate',kachaPct:null,gstPct:null,items:JSON.parse(JSON.stringify(draft.items)),pay:null,doneAt:null,inKhata:false,log:[{at:now,by,k:'created'}]};db.orders.push(o)}
  let advMsg='';
  if(accept&&o.status==='estimate'){o.status='accepted';o.log.push({at:now,by,k:'accepted'})}
  const adv=Number(draft.adv&&draft.adv.amt);
  if(accept&&adv>0&&can('money')){addPay({cust:o.cust,oid:o.id,amt:adv,mode:draft.adv.mode,note:(draft.adv.note||'').trim(),kind:'advance'});advMsg=' '+t('adv_saved',money(adv))}
  save();toast((accept?t('accepted_msg',o.slipNo):t('saved_msg',o.slipNo))+advMsg);
  stack=[{r:'home',p:{}}];go('order',{id:o.id},true);
}

/* ---- order detail ---- */
R.order=p=>{
  const o=db.orders.find(x=>x.id==p.id);if(!o)return bar('—')+'<div class="body"></div>';
  const c=custOf(o.cust),m=can('money'),mode=(o.status==='weighed'||o.status==='done')?'final':'est';
  const items=o.items.map((it,i)=>`<div class="card item"><div class="hd"><span class="num">${i+1}</span><b>${itemDescLen(it)}</b></div><div class="small muted" style="margin:-4px 0 6px">${totalPcs(it)} ${t('pcs')}${it.special?` · <span class="chip c-ok">${t('special')}</span>`:''}</div>${calcHtml(it,mode,m)}</div>`).join('');
  let acts='';
  const advBtn=`<button class="btn b-out sm" data-act="addAdvance" data-id="${o.id}">${t('adv_add')}</button>`;
  if(o.status==='estimate'&&can('new'))acts=`<button class="btn b-out sm" data-act="editOrder" data-id="${o.id}">${t('edit')}</button><button class="btn b-amber" data-act="acceptOrder" data-id="${o.id}">${t('accept')}</button>`;
  else if(o.status==='accepted'&&can('weigh'))acts=`<button class="btn b-green" data-act="go" data-r="weigh" data-id="${o.id}">${ic('scale')}${t('enter_weights')}</button>${m?advBtn:''}`;
  else if(o.status==='accepted'&&m)acts=advBtn;
  else if(o.status==='weighed'&&m)acts=`<button class="btn b-green" data-act="go" data-r="finish" data-id="${o.id}">${t('finish_order')}</button>${advBtn}`;
  else if(o.status==='done')acts=`<button class="btn b-amber" data-act="go" data-r="slip" data-id="${o.id}">${ic('send')}${t('cust_slip')}</button>`;
  const ps=paysOf(o.id).sort((a,b)=>new Date(a.at)-new Date(b.at));
  const payCard=m&&ps.length?`<div class="h2">${t('adv_list')}</div><div class="card flush">${ps.map(p=>`<div class="li" style="cursor:default"><span class="small muted" style="min-width:60px">${dfmt(p.at)}</span><span class="nm"><b>${p.kind==='advance'?t('advance'):t('k_pickup')}</b><span class="xs muted">${esc(p.mode)}${p.note?' · '+esc(p.note):''}</span></span><b class="mono">${money(p.amt)}</b></div>`).join('')}</div>`:'';
  let pay='';
  if(o.status==='done'&&m){const rem=dueOf(o);pay=`<div class="info">${!o.inKhata?t('pay_now_note'):rem>0?t('pay_later_note',money(rem)):t('all_clear')}</div>`}
  const totals=!m?'':o.bill?totalsHtml(o,mode):`<div class="ln big"><span>${t('total')}</span><b class="mono">${money2(orderTotals(o,mode).base)}</b></div>${quoteHtml(o,mode)}`;
  return bar(`#${o.slipNo}`,{sub:`${esc(c.name)} · ${dfmt(o.at)}`,right:o.bill?billChip(o.bill):''})+
  `<div class="body"><div class="row">${statusChip(o.status)}<span class="sp"></span><span class="small muted">${esc(c.phone)}</span></div>${items}
   ${m?`<div class="card">${totals}</div>`:''}${!o.bill&&o.status!=='done'&&m?`<div class="info">${t('bill_pending')}</div>`:''}${payCard}${pay}
   <div class="h2">${t('history')}</div><div class="card flush">${[...o.log].reverse().map(l=>`<div class="li" style="cursor:default"><span class="small muted" style="min-width:88px">${dfmt(l.at)} ${tfmt(l.at)}</span><span class="nm">${t('log_'+l.k)} <span class="muted">· ${esc(l.by)}</span></span></div>`).join('')}</div></div>
   ${acts?`<div class="dock"><div class="acts">${acts}</div></div>`:''}`;
};

/* ---- weighing ---- */
R.weighList=()=>{
  const A=visOrders().filter(o=>o.status==='accepted').sort((a,b)=>a.id-b.id),Rd=visOrders().filter(o=>o.status==='weighed').sort((a,b)=>a.id-b.id);
  const row=(o,act)=>`<button class="li" data-act="go" data-r="${act}" data-id="${o.id}"><span class="no">#${o.slipNo}</span><span class="nm"><b>${esc(custOf(o.cust).name)}</b><span class="xs muted">${o.items.map(i=>i.grade).join(', ')}</span></span>${statusChip(o.status)}</button>`;
  return bar(t('tile_weigh'))+`<div class="body">
   ${can('weigh')?`<div class="h2">${t('waiting_weight')}</div><div class="card flush">${A.length?A.map(o=>row(o,'weigh')).join(''):`<div class="li muted">${t('none')}</div>`}</div>`:''}
   ${can('money')?`<div class="h2">${t('ready_finish')}</div><div class="card flush">${Rd.length?Rd.map(o=>row(o,'finish')).join(''):`<div class="li muted">${t('none')}</div>`}</div>`:''}</div>`;
};
function weighLines(o,sel=[]){
  const multi=o.items.length>1;
  return o.items.map((it,i)=>{
    const c=calcItem(it,'est'),aw=Number(it.aw),m=can('money'),checked=sel.includes(i);
    let st='';if(c&&aw>0){const dev=Math.abs(aw-c.est)/c.est*100;st=dev>db.set.warnPct?`<div class="warn">${t('weigh_warn',fmt(dev,1))}</div>`:`<div class="row" style="color:var(--green);font-weight:700;font-size:14px">${ic('check')}${t('looks_ok')}</div>`}
    return `<div class="card item${checked?' wsel':''}"><div class="hd">${multi?`<button class="wchk${checked?' on':''}" data-act="toggleWSel" data-i="${i}" aria-label="${t('wsel_pick')}">${checked?ic('check'):''}</button>`:`<span class="num">${i+1}</span>`}<b>${itemDescLen(it)}</b></div><div class="small muted">${totalPcs(it)} ${t('pcs')} · ${t('est_word')} ${c?kg(c.est):'—'}</div>
     <div class="xs muted" style="font-weight:600;margin:10px 0 5px">${t('actual_weight')}</div><span class="unit"><input class="in big" inputmode="decimal" data-inp="aw" data-i="${i}" value="${esc(it.aw??'')}" placeholder="0"><i>kg</i></span>
     <div id="wst${i}" style="margin-top:8px">${st}</div>${m?`<div id="wln${i}" class="calc">${aw>0?calcHtml(it,'final',true):''}</div>`:''}</div>`}).join('');
}
/* shown once 2+ items of the SAME grade are ticked: one weight typed in gets split across them by estimated weight
   (never across different grades — that split would be wrong when rates differ) */
function wselBar(o,sel){
  if(!sel||sel.length<2)return '';
  const items=sel.map(i=>o.items[i]);
  return `<div class="card" style="border:2px solid var(--blue)">
   <div class="row"><b style="font-size:16px">${t('wsel_same_grade',esc(items[0].grade))}</b><span class="sp"></span><button class="link" data-act="wselClear">${t('wsel_clear')}</button></div>
   <div class="small muted" style="margin:4px 0 10px">${t('wsel_count',sel.length)}</div>
   <label class="f"><span>${t('wsel_combined')}</span><span class="unit"><input class="in big" id="wselWt" inputmode="decimal" placeholder="0"><i>kg</i></span></label>
   <button class="btn b-green" style="margin-top:12px" data-act="wselApply" data-id="${o.id}">${t('wsel_apply')}</button></div>`;
}
R.weigh=p=>{
  const o=db.orders.find(x=>x.id==p.id);const c=custOf(o.cust),sel=view.p.wsel||[];
  return bar(t('tile_weigh'),{sub:`#${o.slipNo} · ${esc(c.name)}`})+`<div class="body" id="wbody">${weighLines(o,sel)}<div id="wselBar">${wselBar(o,sel)}</div></div>
  <div class="dock">${can('money')?`<div class="tot"><span>${t('final_total')}</span><b class="mono" id="wtot">${wTot(o)}</b></div>`:''}<button class="btn b-green" data-act="submitWeights" data-id="${o.id}">${t('submit_w')}</button></div>`;
};
function wTot(o){const T=orderTotals(o,'final');const all=o.items.every(i=>Number(i.aw)>0);return all?money2(T.total):'—'}
function refreshWeigh(o,i){
  const it=o.items[i],c=calcItem(it,'est'),aw=Number(it.aw);
  const st=$('#wst'+i);if(st&&c){st.innerHTML=aw>0?(Math.abs(aw-c.est)/c.est*100>db.set.warnPct?`<div class="warn">${t('weigh_warn',fmt(Math.abs(aw-c.est)/c.est*100,1))}</div>`:`<div class="row" style="color:var(--green);font-weight:700;font-size:14px">${ic('check')}${t('looks_ok')}</div>`):''}
  const ln=$('#wln'+i);if(ln)ln.innerHTML=aw>0?calcHtml(it,'final',true):'';
  const tt=$('#wtot');if(tt)tt.textContent=wTot(o);
}

/* ---- finish: bill type, advance, how paid ---- */
function finCalc(o,p){
  const bill=p.bill||null;
  const tmp={...o,bill,kachaPct:db.set.kachaPct,gstPct:db.set.gstPct};
  const T=orderTotals(tmp,'final',bill);
  const A=advOf(o),B=r2(Math.max(0,T.total-A)),extra=r2(Math.max(0,A-T.total));
  const mode=B<=0?'now':(p.mode||'later');
  const paidNow=mode==='now'?B:mode==='part'?(Number(p.paid)||0):0;
  return {T,A,B,extra,mode,paidNow,due:r2(Math.max(0,B-paidNow)),bill};
}
const finNote=(o,p)=>{const f=finCalc(o,p);if(!f.bill)return '';if(f.due>0)return t('fin_khata_note',money(f.due),esc(custOf(o.cust).name),f.bill==='pakka'?t('pakka'):t('kacha'),o.slipNo);if(f.extra>0)return t('adv_excess',money(f.extra));return t('fin_no_khata')};
R.finish=p=>{
  const o=db.orders.find(x=>x.id==p.id),c=custOf(o.cust);if(!can('kacha'))p.bill='pakka';const f=finCalc(o,p),pm=p.pmode||'Cash';
  const bopt=(k,ti,su)=>`<button class="opt ${f.bill===k?'on':''}" data-act="finBill" data-b="${k}"><span class="rad">${f.bill===k?ic('check'):''}</span><span><b>${ti}</b><small>${su}</small></span></button>`;
  const opt=(k,ti,su)=>`<button class="opt ${f.mode===k?'on':''}" data-act="payMode" data-m="${k}"><span class="rad">${f.mode===k?ic('check'):''}</span><span><b>${ti}</b><small>${su}</small></span></button>`;
  const adjLine=f.bill==='pakka'?`<div class="ln"><span>${t('gst_line',f.T.pct)}</span><b class="mono">${money2(f.T.gst)}</b></div>`:f.bill==='kacha'?`<div class="ln"><span>${t('local_line',f.T.pct)}</span><b class="mono">${money2(f.T.adj)}</b></div>`:'';
  const amt=`<div class="card"><div class="ln"><span>${t('amt_before')}</span><b class="mono">${money2(f.T.base)}</b></div>${adjLine}
   <div class="ln big"><span>${f.bill?t('final_amount'):t('total')}</span><b class="mono">${money2(f.T.total)}</b></div>
   ${f.bill&&f.A>0?`<div class="ln"><span>${t('adv_less')}</span><b class="mono" style="color:var(--green)">− ${money2(f.A)}</b></div><div class="ln big"><span>${t('bal_collect')}</span><b class="mono">${money2(f.B)}</b></div>`:''}
   ${!f.bill?`<div class="small muted" style="padding-top:8px">${t('choose_bill_hint')}</div>`:''}</div>`;
  const payBlock=!f.bill?'':f.B<=0?`<div class="info" style="background:var(--c-ok-bg);color:var(--c-ok)">${t('adv_covers')}${f.extra>0?' '+t('adv_excess',money(f.extra)):''}</div>`:
   `<div class="h2" style="font-size:17px">${t('how_paying')}</div>
   ${opt('now',t('paid_now'),t('paid_now_s'))}${opt('later',t('pay_later'),t('pay_later_s'))}${opt('part',t('part_paid'),t('part_paid_s'))}
   ${f.mode!=='later'?`<div><div class="xs muted" style="font-weight:600;margin:0 0 5px">${t('pay_via')}</div><div class="seg">${MODES.map(m=>`<button class="${pm===m?'on':''}" data-act="finPM" data-m="${m}">${m}</button>`).join('')}</div></div>`:''}
   ${f.mode==='part'?`<label class="f"><span>${t('amount_paid_now')}</span><span class="unit"><input class="in" id="partAmt" inputmode="decimal" data-inp="part" value="${esc(p.paid||'')}" placeholder="0"><i>₹</i></span></label>`:''}
   ${f.mode!=='later'?`<label class="f"><span>${t('pay_note')}</span><input class="in" data-inp="finPNote" value="${esc(p.note||'')}" placeholder="${t('pay_note_ph')}"></label>`:''}
   <div class="info" id="finNote" style="${f.due>0?'background:var(--c-ok-bg);color:var(--c-ok)':''}">${finNote(o,p)}</div>`;
  return bar(t('finish'),{sub:`#${o.slipNo} · ${esc(c.name)}`})+`<div class="body">
   <div class="h2" style="font-size:17px;margin-top:0">${t('bill_q')}</div>
   ${bopt('pakka',t('bill_gst'),t('bill_gst_s',db.set.gstPct))}${can('kacha')?bopt('kacha',t('bill_none'),t('bill_none_s',db.set.kachaPct)):''}
   ${amt}${payBlock}</div>
   <div class="dock"><button class="btn b-green ${f.bill?'':'is-off'}" data-act="completeOrder" data-id="${o.id}">${f.bill?t('complete_order'):t('choose_bill')}</button></div>`;
};

/* ---- customer slip (no rates, no per-kg) ---- */
function slipParts(o){
  const T=orderTotals(o,'final'),paid=paidOf(o),bal=r2(Math.max(0,T.total-paid));
  return {T,paid,bal,full:paid>=T.total};
}
function slipText(o){
  const {T,paid,bal,full}=slipParts(o),c=custOf(o.cust),sh=db.set.shop;
  let s=`*${sh.name}* — ${t('order_slip')} #${o.slipNo}\n${t('date')}: ${dfmt(o.at,{day:'numeric',month:'short',year:'numeric'})}\n${t('customer')}: ${c.name}${c.phone?` (${c.phone})`:''}\n\n`;
  o.items.forEach((it,i)=>{const cc=calcItem(it,'final'),sh=SHAPES[it.shape],rows=itemRows(it);
    const lenTxt=sh.len?(rows.length<=1?`, ${num(rows[0]?rows[0].len:'')} ${unitTxt(it)}`:` — ${rows.map(r=>`${num(r.len)}${unitTxt(it)}×${Math.floor(Number(r.pcs))||0}`).join(', ')}`):'';
    s+=`${i+1}. ${itemDesc(it)}${lenTxt} — ${totalPcs(it)} ${t('pcs')}${db.set.showWeight&&cc?` — ${kg(cc.weight)}`:''}\n`});
  s+=`\n${t('material')}: ${money2(T.matK)}\n${t('cutting')}: ${money2(T.cutK)}`;
  if(o.bill==='pakka')s+=`\n${t('gst_line',T.pct)}: ${money2(T.gst)}`;
  s+=`\n*${t('total')}: ${money2(T.total)}*`;
  if(full)s+=`\n${t('paid_full')}`;else if(paid>0)s+=`\n${t('paid_so_far')}: ${money2(paid)}\n*${t('bal_to_pay')}: ${money2(bal)}*`;
  if(o.bill==='pakka')s+=`\n(${t('slip_gst')})`;
  return s+`\n\n${t('thanks')}`;
}
function slipPaper(o){
  const {T,paid,bal,full}=slipParts(o),c=custOf(o.cust),sh=db.set.shop,w=db.set.showWeight;
  return `<div class="paper"><div class="ph"><div><h3>${esc(sh.name)}</h3><div class="small" style="color:#5B6C7F">${t('order_slip')}</div></div><div style="text-align:right"><b style="font-size:20px">#${o.slipNo}</b><div class="small" style="color:#5B6C7F">${dfmt(o.at,{day:'numeric',month:'short',year:'numeric'})}</div></div></div>
   <div class="meta"><span>${t('customer')}</span><b>${esc(c.name)}</b>${c.phone?`<span>${t('phone')}</span><span>${esc(c.phone)}</span>`:''}</div>
   <table><tr><th>#</th><th>${t('material')}</th><th class="r">${t('pieces')}</th>${w?`<th class="r">${t('weight')}</th>`:''}</tr>
   ${o.items.map((it,i)=>{const cc=calcItem(it,'final'),sh=SHAPES[it.shape],rows=itemRows(it);
     const lenTxt=sh.len?(rows.length<=1?` · ${num(rows[0]?rows[0].len:'')} ${unitTxt(it)}`:`<br>${rows.map(r=>`${num(r.len)}${unitTxt(it)}×${Math.floor(Number(r.pcs))||0}`).join(', ')}`):'';
     return `<tr><td>${i+1}</td><td><b>${esc(it.grade)}</b> · ${shapeName(it.shape)}<br><span style="color:#5B6C7F">${dimTxt(it)} ${unitTxt(it)}${lenTxt}</span></td><td class="r">${totalPcs(it)}</td>${w&&cc?`<td class="r">${kg(cc.weight)}</td>`:''}</tr>`}).join('')}</table>
   <div class="tots"><div class="tr"><span>${t('material')}</span><b class="mono">${money2(T.matK)}</b></div><div class="tr"><span>${t('cutting')}</span><b class="mono">${money2(T.cutK)}</b></div>${o.bill==='pakka'?`<div class="tr"><span>${t('gst_line',T.pct)}</span><b class="mono">${money2(T.gst)}</b></div>`:''}<div class="tr g"><span>${t('total')}</span><span class="mono">${money2(T.total)}</span></div>
   ${full?`<div class="tr"><span>${t('paid_full')}</span><b class="mono">✓</b></div>`:paid>0?`<div class="tr"><span>${t('paid_so_far')}</span><b class="mono">${money2(paid)}</b></div><div class="tr g"><span>${t('bal_to_pay')}</span><span class="mono">${money2(bal)}</span></div>`:''}</div>
   <div class="foot">${o.bill==='pakka'?t('slip_gst')+'<br>':''}${sh.phone?esc(sh.phone)+' · ':''}${t('thanks')}</div></div>`;
}
R.slip=p=>{
  const o=db.orders.find(x=>x.id==p.id),c=custOf(o.cust),txt=slipText(o);
  return bar(t('cust_slip'),{sub:`#${o.slipNo} · ${esc(c.name)}`,right:billChip(o.bill)})+`<div class="body">
   <div class="info">${db.set.showWeight?t('slip_hidden_note_w'):t('slip_hidden_note')}</div>${slipPaper(o)}
   ${db.set.showWeight?`<div class="warn">${t('weight_on_warn')}</div>`:''}</div>
   <div class="dock"><a class="btn b-green" href="${waLink(c.phone,txt)}" target="_blank" rel="noopener">${ic('send')}${t('send_wa')}</a><div class="acts"><button class="btn b-out sm" data-act="copy" data-txt="${esc(txt)}">${ic('copy')}${t('copy_text')}</button><button class="btn b-out sm" data-act="go" data-r="order" data-id="${o.id}">${t('internal_view')}</button></div></div>`;
};

const fa=n=>{n=r2(Number(n)||0);return fmt(n,Number.isInteger(n)?0:2)};
const payLabel=e=>e.pending?t('adv_open',slipNoOf(e.oid)):e.kind==='advance'?t('kind_adv'):e.kind==='pay'?t('kind_pick'):t('payment');
/* ---- khata ---- */
function dueChip(l){const d=l.oldest?daysSince(l.oldest):0;return d>=30?['old','c-bad']:d>=10?['mid','c-amber']:['','c-blue']}
const dueBucket=l=>{const d=l.oldest?daysSince(l.oldest):0;return d>=30?'old':d>=10?'mid':'fresh'};
R.khata=p=>{
  const sort=p.s||'old',bucket=p.b||'all';let L=khataList();
  const q=(p.q||'').toLowerCase();if(q)L=L.filter(x=>x.c.name.toLowerCase().includes(q)||x.c.phone.replace(/\s/g,'').includes(q));
  const allDues=L.filter(x=>x.l.due>0),advs=L.filter(x=>x.l.adv>0&&x.l.due<=0);
  const buckets={fresh:{n:0,amt:0},mid:{n:0,amt:0},old:{n:0,amt:0}};
  allDues.forEach(x=>{const k=dueBucket(x.l);buckets[k].n++;buckets[k].amt=r2(buckets[k].amt+x.l.due)});
  const dues=bucket==='all'?allDues:allDues.filter(x=>dueBucket(x.l)===bucket);
  dues.sort((a,b)=>sort==='old'?new Date(a.l.oldest)-new Date(b.l.oldest):b.l.due-a.l.due);
  const all=khataList(),tot=all.reduce((a,x)=>a+x.l.due,0),adv=all.reduce((a,x)=>a+x.l.adv,0);
  const row=x=>{const [st,ch]=dueChip(x.l),d=x.l.oldest?daysSince(x.l.oldest):0;return `<button class="li stripe ${st}" data-act="go" data-r="customer" data-id="${x.c.id}"><span class="nm"><b>${esc(x.c.name)}</b><span class="xs muted">${t('oldest_bill',d)}</span></span><span class="amt"><b class="mono">${money(x.l.due)}</b><span class="chip ${ch}">${t('n_days',d)}</span>${x.l.adv>0?`<span class="chip c-ok" style="margin-left:4px">${t('advance')} ${money(x.l.adv)}</span>`:''}</span></button>`};
  const arow=x=>`<button class="li stripe adv" data-act="go" data-r="customer" data-id="${x.c.id}"><span class="nm"><b>${esc(x.c.name)}</b><span class="xs muted">${t('paid_advance')}</span></span><span class="amt"><b class="mono" style="color:var(--green)">${money(x.l.adv)}</b><span class="chip c-ok">${t('advance')}</span></span></button>`;
  const bcell=(k,lbl,col)=>`<button class="card threecell ${bucket===k?'sel':''}" data-act="khBucket" data-b="${k}"><small>${lbl}</small><b class="mono" style="color:${col}">${buckets[k].n}</b><span class="xs muted">${money(buckets[k].amt)}</span></button>`;
  return bar(t('tile_khata'),{sub:t('who_owes')})+`<div class="body">
   <div class="two"><div class="card"><small>${t('to_receive_cap')}</small><b class="mono" style="color:var(--c-kacha)">${money(tot)}</b></div><div class="card"><small>${t('advances_held')}</small><b class="mono" style="color:var(--green)">${money(adv)}</b></div></div>
   <div class="h2">${t('aging_title')}</div>
   <div class="three">${bcell('fresh',t('due_fresh'),'var(--c-pakka)')}${bcell('mid',t('due_mid'),'var(--c-kacha)')}${bcell('old',t('due_old'),'var(--c-bad)')}</div>
   <label class="search">${ic('search')}<input data-inp="kq" value="${esc(p.q||'')}" placeholder="${t('search_cust')}"></label>
   <div class="seg"><button class="${sort==='old'?'on':''}" data-act="khSort" data-s="old">${t('oldest_first')}</button><button class="${sort==='big'?'on':''}" data-act="khSort" data-s="big">${t('biggest_first')}</button></div>
   <div class="card flush">${dues.length||(bucket==='all'&&advs.length)?dues.map(row).join('')+(bucket==='all'?advs.map(arow).join(''):''):`<div class="li muted">${t('none')}</div>`}</div>
   <div class="info">${t('khata_note')}</div>${can('khata')?`<button class="dash" data-act="addPaymentAny">${ic('plus')}${t('add_payment')}</button>`:''}</div>`;
};
R.customer=p=>{
  const c=custOf(p.id),f=p.f||'all',sides=f==='all'?visSides():[f].filter(s=>visSides().includes(s));
  const l=ledger(c.id,sides),L=ledger(c.id,visSides());
  const rows=[...l.entries].reverse().map(e=>{
    if(e.t==='bill'){const b=l.bills.find(x=>x.oid===e.oid);const st=b.rem<=0?['c-ok',t('s_paid')]:b.rem<b.amt?['c-amber',t('s_part')]:['c-bad',t('s_unpaid')];
      return `<button class="tx" data-act="go" data-r="order" data-id="${e.oid}"><span class="d">${dfmt(e.date)}</span><span class="m"><b>#${slipNoOf(e.oid)}</b> ${billChip(e.side)}<small><span class="chip ${st[0]}">${st[1]}</span></small></span><span class="a plus mono">+${fa(e.amt)}<small>${t('bal')} ${fa(e.bal)}</small></span></button>`}
    return `<div class="tx"><span class="d">${dfmt(e.date)}</span><span class="m"><b>${payLabel(e)}</b> ${e.side?billChip(e.side):''}<small>${esc(e.mode)}${e.oid&&!e.pending?` · #${slipNoOf(e.oid)}`:''}${e.note?` · ${esc(e.note)}`:''}</small></span><span class="a minus mono">−${fa(e.amt)}<small>${t('bal')} ${fa(e.bal)}</small></span></div>`}).join('');
  const sd=Object.entries(L.bySide).filter(([k,v])=>v.due>0).map(([k,v])=>`<span>${k==='pakka'?t('pakka'):t('kacha')} ${money(v.due)}</span>`).join('');
  return bar(esc(c.name),{sub:esc(c.phone)||t('no_phone')})+`<div class="body">
   <div class="bal"><small>${L.due>0?t('owes_you'):L.adv>0?t('advance_held'):t('all_clear')}</small><div class="big mono">${money(L.due>0?L.due:L.adv)}</div><div class="sp2">${sd}${L.adv>0&&L.due>0?`<span>${t('advance')} ${money(L.adv)}</span>`:''}</div></div>
   ${can('kacha')?`<div class="seg"><button class="${f==='all'?'on':''}" data-act="custFilter" data-f="all">${t('f_all')}</button><button class="${f==='pakka'?'on':''}" data-act="custFilter" data-f="pakka">${t('pakka')}</button><button class="${f==='kacha'?'on':''}" data-act="custFilter" data-f="kacha">${t('kacha')}</button></div>`:''}
   <div class="card flush">${rows||`<div class="li muted">${t('none')}</div>`}</div><div class="info">${t('tap_slip')}</div></div>
   <div class="dock"><div class="acts"><button class="btn b-green sm" data-act="addPayment" data-id="${c.id}">${t('add_payment')}</button><button class="btn b-amber sm" data-act="go" data-r="statement" data-id="${c.id}" data-f="all" style="flex:1.3">${ic('send')}${t('share_stmt')}</button></div></div>`;
};
function stmtData(cid,f){
  const sides=f==='all'?visSides():[f].filter(s=>visSides().includes(s));return {l:ledger(cid,sides),sides};
}
function stmtText(cid,f){
  const c=custOf(cid),{l}=stmtData(cid,f),sh=db.set.shop;
  let s=`*${sh.name}* — ${t('statement')}\n${t('customer')}: ${c.name}\n${t('as_on')} ${dfmt(new Date().toISOString(),{day:'numeric',month:'short',year:'numeric'})}\n\n`;
  l.entries.forEach(e=>{s+=e.t==='bill'?`${dfmt(e.date)}  #${slipNoOf(e.oid)}  ${e.side==='pakka'?t('pakka'):t('kacha')}  ${money(e.amt)}\n`:`${dfmt(e.date)}  ${payLabel(e)} (${e.mode})${e.oid&&!e.pending?` #${slipNoOf(e.oid)}`:''}  −${money(e.amt)}\n`});
  s+=`\n*${l.due>0?t('total_to_pay')+': '+money(l.due):t('all_clear')}*${l.adv>0?`\n${t('advance')}: ${money(l.adv)}`:''}\n\n${t('pls_clear')}`;return s;
}
R.statement=p=>{
  const c=custOf(p.id),f=p.f||'all',{l}=stmtData(c.id,f),sh=db.set.shop,txt=stmtText(c.id,f);
  const rows=l.entries.map(e=>e.t==='bill'
    ?`<tr><td>${dfmt(e.date)}</td><td><b>#${slipNoOf(e.oid)}</b> · ${e.side==='pakka'?t('pakka'):t('kacha')}</td><td class="r mono">${fa(e.amt)}</td><td></td></tr>`
    :`<tr><td>${dfmt(e.date)}</td><td>${payLabel(e)}<br><span style="color:#5B6C7F">${esc(e.mode)}${e.oid&&!e.pending?` · #${slipNoOf(e.oid)}`:''}${e.side&&f==='all'&&can('kacha')?` · ${e.side==='pakka'?t('pakka'):t('kacha')}`:''}</span></td><td></td><td class="r mono">${fa(e.amt)}</td></tr>`).join('');
  return bar(t('share_stmt'),{sub:esc(c.name)})+`<div class="body"><div class="h2" style="font-size:16px;margin:0 2px">${t('what_see')}</div>
   ${can('kacha')?`<div class="seg amb"><button class="${f==='all'?'on':''}" data-act="stmtF" data-f="all">${t('both')}</button><button class="${f==='pakka'?'on':''}" data-act="stmtF" data-f="pakka">${t('pakka_only')}</button><button class="${f==='kacha'?'on':''}" data-act="stmtF" data-f="kacha">${t('kacha_only')}</button></div>`:''}
   <div class="paper"><h3>${esc(sh.name)}</h3><div class="small" style="color:#5B6C7F;margin-bottom:8px">${t('statement_for')} <b>${esc(c.name)}</b> · ${t('as_on')} ${dfmt(new Date().toISOString(),{day:'numeric',month:'short',year:'numeric'})}</div>
   <table><tr><th>${t('date')}</th><th>${t('details')}</th><th class="r">${t('bill')}</th><th class="r">${t('paid')}</th></tr>
   ${rows||`<tr><td colspan="4" style="color:#5B6C7F">${t('none')}</td></tr>`}</table>
   <div class="tots"><div class="tr g"><span>${l.due>0||l.adv<=0?t('total_to_pay'):t('advance')}</span><span class="mono">${money(l.due>0||l.adv<=0?l.due:l.adv)}</span></div></div><div class="foot">${t('pls_clear')}</div></div>
   <div class="info">${t('stmt_note')}</div></div>
   <div class="dock"><a class="btn b-green" href="${waLink(c.phone,txt)}" target="_blank" rel="noopener">${ic('send')}${t('send_wa')}</a><button class="btn b-out sm" data-act="copy" data-txt="${esc(txt)}">${ic('copy')}${t('copy_text')}</button></div>`;
};

/* ---- today ---- */
function cashCloseCard(){
  const todayKey=new Date().toISOString().slice(0,10);
  const cc=(db.cashClose&&db.cashClose[todayKey])||{};
  const mbm=moneyByMode(),expected=mbm.Cash||0;
  const val=view.p.cc!=null?view.p.cc:(cc.counted!=null?String(cc.counted):'');
  return `<div class="h2">${t('cash_close_title')}</div>
   <div class="card"><div class="ln"><span>${t('cash_expected')}</span><b class="mono">${money2(expected)}</b></div>
   <label class="f" style="margin-top:8px"><span>${t('cash_counted')}</span><span class="unit"><input class="in big" id="cashCount" inputmode="decimal" data-inp="cashCount" value="${esc(val)}" placeholder="0"><i>₹</i></span></label>
   <div class="ln big" id="cashDiff">${cashDiffHtml(Number(val)||0,expected)}</div>
   <button class="btn b-navy sm" style="margin-top:10px" data-act="saveCashClose">${t('cash_save')}</button>
   ${cc.at?`<div class="xs muted" style="margin-top:8px">${t('cash_saved_at',dfmt(cc.at),tfmt(cc.at),esc(cc.by))}</div>`:''}</div>`;
}
function cashDiffHtml(counted,expected){
  const diff=r2(counted-expected),ok=diff===0;
  return `<span>${t('cash_diff')}</span><b class="mono" style="color:${ok?'var(--green)':'var(--c-bad)'}">${diff>0?'+':''}${money2(diff)}</b>`;
}
function wastageCard(){
  const w=wastageStats();
  if(!w.n)return `<div class="h2">${t('wastage_title')}</div><div class="card small muted">${t('wastage_none')}</div>`;
  const flags=w.flags.slice(0,8).map(f=>{const o=db.orders.find(x=>x.id===f.oid);if(!o)return '';const it=o.items[f.i];return `<button class="li" data-act="go" data-r="order" data-id="${f.oid}"><span class="nm"><b>#${o.slipNo} · ${esc(custOf(o.cust).name)}</b><span class="xs muted">${itemDescLen(it)}</span></span><span class="chip c-bad">${fmt(f.dev,1)}%</span></button>`}).join('');
  return `<div class="h2">${t('wastage_title')}</div>
   <div class="card flush"><div class="kv"><div><span class="l">${t('wastage_est')}</span></div><b class="mono">${kg(w.est)}</b></div>
   <div class="kv"><div><span class="l">${t('wastage_act')}</span></div><b class="mono">${kg(w.act)}</b></div>
   <div class="kv" style="background:var(--seg)"><div><span class="l" style="font-weight:800">${t('wastage_diff')}</span><small>${t('wastage_diff_s')}</small></div><b class="mono" style="color:${w.diff>0?'var(--c-kacha)':'var(--green)'}">${w.diff>0?'+':''}${kg(w.diff)} (${w.pct>0?'+':''}${fmt(w.pct,1)}%)</b></div></div>
   ${flags?`<div class="warn">${t('wastage_flag',w.flags.length)}</div><div class="card flush">${flags}</div>`:''}`;
}
R.summary=()=>{
  const s=summaryToday(),k=can('kacha'),tot=k?s.total:s.pk,pkw=tot?Math.round((s.pk/tot)*100):0;
  return bar(t('tile_today'),{sub:dfmt(new Date().toISOString(),{weekday:'long',day:'numeric',month:'short',year:'numeric'})})+`<div class="body">
   ${can('money')?`<div class="bal"><small>${t('sales_today')}${k?'':' ('+t('pakka')+')'}</small><div class="big mono">${money(tot)}</div>
   ${k?`<div class="bar2"><i style="width:${pkw}%;background:#6FB2EA"></i><i style="width:${100-pkw}%;background:var(--amber)"></i></div><div class="row small" style="justify-content:space-between"><span><span class="dot" style="background:#6FB2EA"></span>${t('pakka')} ${money(s.pk)}</span><span><span class="dot" style="background:var(--amber)"></span>${t('kacha')} ${money(s.kc)}</span></div>`:''}</div>
   <div class="card flush"><div class="kv"><div><span class="l">${t('paid_spot')}</span><small>${t('paid_spot_s')}</small></div><b class="mono" style="color:var(--green)">${money(s.spot)}</b></div>
   <div class="kv"><div><span class="l">${t('from_adv')}</span><small>${t('from_adv_s')}</small></div><b class="mono" style="color:var(--green)">${money(s.fromAdv)}</b></div>
   <div class="kv"><div><span class="l">${t('went_khata')}</span><small>${t('pay_later')}</small></div><b class="mono" style="color:var(--c-kacha)">${money(s.khata)}</b></div></div>
   <div class="h2">${t('money_in')}</div>
   <div class="card flush"><div class="kv"><div><span class="l">${t('paid_spot')}</span></div><b class="mono">${money(s.spot)}</b></div>
   <div class="kv"><div><span class="l">${t('adv_taken')}</span><small>${t('adv_taken_s')}</small></div><b class="mono">${money(s.advTaken)}</b></div>
   <div class="kv"><div><span class="l">${t('old_collected')}</span><small>${t('old_collected_s')}</small></div><b class="mono">${money(s.collected)}</b></div>
   <div class="kv" style="background:var(--seg)"><div><span class="l" style="font-weight:800">${t('total_in')}</span></div><b class="mono" style="font-size:20px">${money(s.moneyIn)}</b></div></div>
   ${cashCloseCard()}`:''}
   ${can('today')?wastageCard():''}
   <div class="card"><div class="l" style="font-size:17px;font-weight:700">${t('orders_today')}: ${s.n}</div><div class="small muted">${t('open_line',s.done,s.toWeigh,s.ready,s.est)}</div></div>
   <div class="info">${t('kacha_perm_note')}</div></div>
   <div class="dock"><button class="btn b-out" data-act="go" data-r="orders" data-f="today">${t('see_today')}</button></div>`;
};

/* ---- rates ---- */
R.rates=()=>{
  const fam=Object.keys(FAMILIES).map(f=>`<label class="f"><span>${famName(f)} (kg/m³)</span><input class="in" inputmode="numeric" data-inp="famd" data-f="${f}" value="${FAMILIES[f].d}"></label>`).join('');
  const mats=db.mats.map((m,i)=>`<div class="card"><div class="row" style="margin-bottom:10px"><div class="sp"><b style="font-size:20px">${esc(m.id)}</b> <span class="chip c-blue">${famName(m.family)}</span></div><button class="infob" data-act="info" data-mat="${esc(m.id)}" aria-label="${t('info')}">i</button></div>
    <div class="fg"><label class="f"><span>${t('rate_kg')}</span><span class="unit"><input class="in" inputmode="decimal" data-inp="msell" data-i="${i}" value="${m.sell}"><i>₹/kg</i></span></label><label class="f"><span>${t('cut_rate')}</span><span class="unit"><input class="in" inputmode="decimal" data-inp="mcut" data-i="${i}" value="${m.cut}"><i>₹</i></span></label>
    <label class="f full"><span>${t('density')} — ${m.density?t('own_dens'):t('fam_dens')}</span><span class="unit"><input class="in" inputmode="numeric" data-inp="mden" data-i="${i}" value="${m.density??''}" placeholder="${FAMILIES[m.family].d}"><i>kg/m³</i></span></label></div></div>`).join('');
  const sp=db.cust.flatMap(c=>Object.entries(c.special||{}).map(([mid,r])=>({c,mid,r})));
  return bar(t('tile_rates'))+`<div class="body"><div class="warn">${t('sample_rates')}</div>
   <button class="btn b-out sm" data-act="addMat">${ic('plus')}${t('add_material')}</button>
   <div class="h2">${t('mat_list')}</div>${mats}
   <div class="h2">${t('special_rates')}</div><div class="card flush">${sp.length?sp.map(x=>`<div class="li" style="cursor:default"><span class="nm"><b>${esc(x.c.name)}</b><span class="xs muted">${esc(x.mid)}</span></span><b class="mono">₹${x.r}/kg</b><button class="link" data-act="rmSpecial" data-c="${x.c.id}" data-m="${esc(x.mid)}" aria-label="${t('remove')}">${ic('trash')}</button></div>`).join(''):`<div class="li muted">${t('none')}</div>`}</div>
   <button class="btn b-out sm" data-act="addSpecial">${ic('plus')}${t('add_special')}</button>
   <div class="h2">${t('family_dens')}</div><div class="card"><div class="fg">${fam}</div><div class="small muted" style="margin-top:8px">${t('dens_rule')}</div></div></div>`;
};

/* ---- people ---- */
R.people=()=>{
  return bar(t('tile_people'))+`<div class="body"><div class="info">${t('people_note')}</div>
  ${db.users.map(u=>`<details class="card flush u"><summary><span class="avatar" style="width:40px;height:40px;font-size:18px">${esc(u.name[0])}</span><span class="sp"><b>${esc(u.name)}</b><div class="xs muted">${roleName(u.role)}</div></span><span class="link">${t('edit')}</span></summary><div class="pm">
   ${PERMS.map(p=>`<div class="perm"><span>${t('perm_'+p)}</span><button class="sw ${u.perms[p]?'on':''}" data-act="togPerm" data-u="${u.id}" data-p="${p}" role="switch" aria-checked="${!!u.perms[p]}" aria-label="${t('perm_'+p)}"></button></div>`).join('')}</div></details>`).join('')}
  <button class="btn b-out sm" data-act="addUser">${ic('plus')}${t('add_person')}</button></div>`;
};

/* ---- settings ---- */
R.settings=()=>{
  const s=db.set;
  return bar(t('tile_settings'))+`<div class="body">
   <div class="h2">${t('language')}</div><div class="seg"><button class="${db.lang==='en'?'on':''}" data-act="setLang" data-l="en">English</button><button class="${db.lang==='hi'?'on':''}" data-act="setLang" data-l="hi">हिंदी</button><button class="${db.lang==='hn'?'on':''}" data-act="setLang" data-l="hn">Hinglish</button></div>
   <div class="h2">${t('rules')}</div><div class="card"><div class="fg">
    <label class="f"><span>${t('kacha_pct')}</span><span class="unit"><input class="in" inputmode="decimal" data-inp="s_kachaPct" value="${s.kachaPct}"><i>%</i></span></label>
    <label class="f"><span>${t('gst_pct')}</span><span class="unit"><input class="in" inputmode="decimal" data-inp="s_gstPct" value="${s.gstPct}"><i>%</i></span></label>
    <label class="f"><span>${t('min_inch')}</span><span class="unit"><input class="in" inputmode="numeric" data-inp="s_minInch" value="${s.minInch}"><i>in</i></span></label>
    <label class="f"><span>${t('warn_pct')}</span><span class="unit"><input class="in" inputmode="decimal" data-inp="s_warnPct" value="${s.warnPct}"><i>%</i></span></label></div>
    <div class="xs muted" style="font-weight:600;margin:12px 0 5px">${t('unit_default')}</div><div class="seg"><button class="${(s.unit||'mm')==='mm'?'on':''}" data-act="setUnitDef" data-u="mm">${t('u_mm')}</button><button class="${s.unit==='in'?'on':''}" data-act="setUnitDef" data-u="in">${t('u_in')}</button></div>
    <div class="small muted" style="margin-top:10px;line-height:1.5">${t('rules_note')}</div></div>
   <div class="h2">${t('slip_settings')}</div><div class="card"><div class="perm"><span>${t('show_weight')}</span><button class="sw ${s.showWeight?'on':''}" data-act="togWeight" role="switch" aria-checked="${s.showWeight}" aria-label="${t('show_weight')}"></button></div><div class="small muted" style="margin-top:6px">${t('show_weight_note')}</div>
    <div class="xs muted" style="font-weight:600;margin:14px 0 5px">${t('num_reset')}</div>
    <div class="seg wrap">${[['never',t('num_never')],['daily',t('num_daily')],['monthly',t('num_monthly')],['yearly',t('num_yearly')]].map(([k,l])=>`<button class="${(s.numReset||'never')===k?'on':''}" data-act="setNumReset" data-k="${k}">${l}</button>`).join('')}</div>
    <div class="small muted" style="margin-top:8px;line-height:1.5">${t('num_reset_note')}</div>
    <div class="small" id="numResetPreview" style="margin-top:6px">${t('num_reset_preview')} <b class="mono">#${peekSlipNo()}</b></div></div>
   <div class="h2">${t('shop')}</div><div class="card"><div class="fg"><label class="f full"><span>${t('shop_name')}</span><input class="in" data-inp="s_shopname" value="${esc(s.shop.name)}"></label><label class="f"><span>${t('phone')}</span><input class="in" inputmode="tel" data-inp="s_shopphone" value="${esc(s.shop.phone)}"></label><label class="f"><span>GST</span><input class="in" data-inp="s_shopgst" value="${esc(s.shop.gst)}"></label></div></div>
   <button class="btn b-red sm" data-act="resetDemo">${t('reset_demo')}</button></div>`;
};

/* ---- Steel Guide: search uses and questions ---- */
let SAMPLE=null,askCtl=null,guideAns=null;
try{if(window.claude&&window.claude.use)window.claude.use('sample').then(s=>{SAMPLE=s||null;const a=$('#askbox');if(a&&view.r==='guide')a.innerHTML=askHtml()}).catch(()=>{})}catch(e){}
const gRow=(g,txt,cls)=>`<div class="grow ${cls}"><button class="gchip" data-act="info" data-mat="${esc(g)}"><b>${esc(g)}</b><span class="gi">i</span></button><span>${esc(pick(txt))}</span></div>`;
function guideCard(e,open){
  const cmp=e.id.startsWith('vs_'),[best,...also]=e.pick;
  const sub=cmp?e.pick.map(p=>p[0]).join(' · '):`${t('g_best')}: ${best[0]}${also.length?' · '+also.map(a=>a[0]).join(', '):''}`;
  return `<details class="gcard" ${open?'open':''}><summary><span class="sp"><b style="font-size:17px">${esc(pick(e.name))}</b><div class="xs muted">${esc(sub)}</div></span></summary><div class="gb">
   ${cmp?`<div class="gh">${t('g_diff')}</div>${e.pick.map(p=>gRow(p[0],p[1],'')).join('')}`:
   `<div class="gh">${t('g_best')}</div>${gRow(best[0],best[1],'best')}
   ${also.length?`<div class="gh">${t('g_also')}</div>${also.map(a=>gRow(a[0],a[1],'')).join('')}`:''}
   ${e.avoid.length?`<div class="gh bad">${t('g_avoid')}</div>${e.avoid.map(a=>gRow(a[0],a[1],'no')).join('')}`:''}`}
   <div class="gh" style="color:var(--mute)">${t('g_how')}</div><div class="gtxt">${esc(pick(e.how))}</div>
   <div class="gsay"><b>${t('g_say')}</b><div>“${esc(pick(e.say))}”</div><button class="link" data-act="copy" data-txt="${esc(pick(e.say))}">${ic('copy')}${t('copy_text')}</button></div></div></details>`;
}
function guideResults(q){
  const {toks,hits,grades}=guideSearch(q);
  if(!toks.length){
    return `<div class="h2" style="margin-top:0">${t('g_try')}</div><div class="exs">${GUIDE.filter(e=>!e.id.startsWith('vs_')).slice(0,10).map(e=>`<button class="pill" data-act="gset" data-q="${esc(pick(e.name))}">${esc(pick(e.name))}</button>`).join('')}</div>
     <div class="h2">${t('g_all')}</div>${GUIDE.map(e=>guideCard(e,false)).join('')}`;
  }
  const gr=grades.length?`<div class="h2" style="margin-top:0">${t('g_grades')}</div><div class="card flush">${grades.map(m=>`<button class="li" data-act="info" data-mat="${esc(m.id)}"><span class="nm"><b>${esc(m.id)}</b><span class="xs muted">${famName(m.family)}${m.info?' · '+esc(m.info.eq):''}</span></span><span class="infob">i</span></button>`).join('')}</div>`:'';
  const cards=hits.slice(0,6).map((e,i)=>guideCard(e,i===0)).join('');
  if(!gr&&!cards)return `<div class="card"><b>${t('g_none')}</b><div class="small muted" style="margin-top:4px">${t('g_none_s')}</div></div><div class="h2">${t('g_try')}</div><div class="exs">${GUIDE.filter(e=>!e.id.startsWith('vs_')).slice(0,8).map(e=>`<button class="pill" data-act="gset" data-q="${esc(pick(e.name))}">${esc(pick(e.name))}</button>`).join('')}</div>`;
  return gr+cards;
}
function askHtml(){
  const q=(view.p&&view.p.q)||'';
  if(!SAMPLE)return `<div class="card"><b style="font-size:17px">${t('g_ask')}</b><div class="small muted" style="margin-top:4px">${t('g_offline')}</div></div>`;
  return `<div class="card"><b style="font-size:17px">${t('g_ask')}</b><div class="small muted" style="margin:2px 0 10px">${t('g_ask_note')}</div>
   <textarea class="in" id="askq" rows="3" placeholder="${t('g_ask_ph')}">${esc(guideAns?guideAns.q:q)}</textarea>
   <div class="row" style="margin-top:10px"><button class="btn b-navy sm" id="askbtn" data-act="askAI">${t('g_ask_send')}</button><button class="btn b-out sm" id="askstop" data-act="askStop" style="display:none">${t('g_stop')}</button></div>
   <div id="askout" class="askout" style="${guideAns?'':'display:none'}">${guideAns?esc(guideAns.text):''}</div><div class="xs muted" id="asknote" style="margin-top:8px;${guideAns?'':'display:none'}">${t('g_ai_note')}</div></div>`;
}
function askPrompt(q){
  const lang={en:'simple English',hi:'simple Hindi in Devanagari script',hn:'Hinglish (Hindi written in English letters)'}[db.lang]||'simple English';
  const stock=db.mats.filter(m=>m.active).map(m=>`${m.id} (${famName(m.family)})`).join(', ');
  return `You are the helper inside the app of a steel trading shop in India. The shop sells and cuts (bandsaw) steel bars, flats and plates. A shopkeeper or worker asks you a question so they can advise a customer.
Grades in stock: ${stock}.
Rules:
- Answer in ${lang}. Very simple words, no jargon. Maximum 8 short lines. No headings, no markdown symbols, no tables.
- Say what to use and why. If useful, say how to work it (machining, welding, heat treatment) and what to watch out for.
- Prefer grades from the stock list. If nothing in stock fits, say so and name the closest option. Do not invent grades or facts.
- Never give prices. If unsure, or if safety is involved (lifting, pressure, structures), tell them to check with a senior person or an engineer.
Question: ${q}`;
}
R.guide=p=>{
  const q=p.q||'';
  return bar(t('guide_title'),{sub:t('guide_sub')})+`<div class="body">
   <label class="search">${ic('search')}<input id="gq" data-inp="gq" value="${esc(q)}" placeholder="${t('guide_search')}" autocomplete="off" enterkeyhint="search"></label>
   <div id="gres">${guideResults(q)}</div>
   <div id="askbox">${askHtml()}</div>
   <div class="info">${t('g_draft')}</div></div>`;
};

/* ============ sheets ============ */
function matPickSheet(i,fam='all',q=''){
  sheetCtx={type:'pick',i,fam,q};
  const L=db.mats.filter(m=>m.active&&(fam==='all'||m.family===fam)&&(!q||m.id.toLowerCase().includes(q.toLowerCase())));
  const cur=draft.items[i].matId;
  openSheet(t('choose_grade'),`<label class="search">${ic('search')}<input id="mq" data-inp="mq" value="${esc(q)}" placeholder="${t('search_grade')}"></label>
   <div class="tabs"><button class="pill ${fam==='all'?'on':''}" data-act="pickFam" data-f="all">${t('f_all')}</button>${Object.keys(FAMILIES).map(f=>`<button class="pill ${fam===f?'on':''}" data-act="pickFam" data-f="${f}">${famName(f)}</button>`).join('')}</div>
   <div class="list-pick">${L.map(m=>`<div class="pk ${m.id===cur?'sel':''}"><button class="main" data-act="selMat" data-i="${i}" data-mat="${esc(m.id)}"><b>${esc(m.id)}</b><span>${famName(m.family)}${can('money')?` · ₹${m.sell}/kg`:''}</span></button><button class="infob" data-act="info" data-mat="${esc(m.id)}" data-i="${i}" data-from="pick" aria-label="${t('info')}">i</button></div>`).join('')||`<div class="pk muted">${t('none')}</div>`}</div>`);
  if(q){const el=$('#mq');if(el){el.focus();el.setSelectionRange(q.length,q.length)}}
}
function infoSheet(id,i,from){
  const m=matById(id);if(!m)return;const inf=m.info;
  sheetCtx={type:'info',id,i,from};
  const alts=(inf&&inf.alts||[]).filter(a=>matById(a[0]));
  const canSwap=i!=null&&i!=='undefined'&&draft&&draft.items[i];
  openSheet(`${esc(m.id)} <span class="chip c-blue" style="vertical-align:middle">${famName(m.family)}</span>`,
   inf?`<div class="small muted">${t('closest_eq')}: <b>${esc(inf.eq)}</b></div>
   <div><div class="h2" style="margin:0 0 6px">${t('what_is')}</div><div class="card">${esc(pick(inf.what))}</div></div>
   <div><div class="h2" style="margin:0 0 6px">${t('good_for')}</div><div>${pick(inf.good).map(g=>`<span class="tag">${esc(g)}</span>`).join('')}</div></div>
   <div class="warn"><b>${t('watch_out')}:</b> ${esc(pick(inf.watch))}</div>
   <div><div class="h2" style="margin:0 0 6px">${t('if_out')}</div>${alts.length?alts.map(a=>`<div class="alt"><div class="row"><b style="font-size:18px">${esc(a[0])}</b><span class="sp"></span><button class="link" data-act="info" data-mat="${esc(a[0])}" ${canSwap?`data-i="${i}"`:''} data-from="${from||''}">${t('see_info')}</button></div><div class="small muted">${esc(pick(a[1]))}</div>${canSwap?`<button class="btn b-amber sm" data-act="selMat" data-i="${i}" data-mat="${esc(a[0])}">${t('use_instead',esc(a[0]))}</button>`:''}</div>`).join(''):`<div class="card small">${t('no_swap')}</div>`}</div>
   <div class="xs muted">${t('info_draft')}</div>`:`<div class="card">${t('no_info')}</div>`,
   `${from==='pick'?`<button class="btn b-out sm" data-act="backPick">${t('back')}</button>`:''}${canSwap?`<button class="btn b-navy sm" data-act="selMat" data-i="${i}" data-mat="${esc(id)}">${t('use_this',esc(id))}</button>`:`<button class="btn b-navy sm" data-act="closeSheet">${t('close')}</button>`}`);
}
function custSheet(q=''){
  sheetCtx={type:'cust',q};
  const L=db.cust.filter(c=>!q||c.name.toLowerCase().includes(q.toLowerCase())||c.phone.replace(/\s/g,'').includes(q.replace(/\s/g,'')));
  openSheet(t('choose_customer'),`<label class="search">${ic('search')}<input id="cq" data-inp="cq" value="${esc(q)}" placeholder="${t('search_cust')}"></label>
   <div class="list-pick">${L.map(c=>`<div class="pk ${draft&&draft.cust===c.id?'sel':''}"><button class="main" data-act="selCust" data-id="${c.id}"><b>${esc(c.name)}</b><span>${esc(c.phone)||t('no_phone')}</span></button></div>`).join('')||`<div class="pk muted">${t('none')}</div>`}</div>
   <div class="card"><div class="h2" style="margin:0 0 8px">${t('new_customer')}</div><div class="fg"><label class="f full"><span>${t('name')}</span><input class="in" id="ncName"></label><label class="f full"><span>${t('phone')}</span><input class="in" id="ncPhone" inputmode="tel"></label></div><button class="btn b-navy sm" style="margin-top:10px;width:100%" data-act="addCust">${t('add_save')}</button></div>`);
  if(q){const el=$('#cq');if(el){el.focus();el.setSelectionRange(q.length,q.length)}}
}
function paySheet(cid){
  const opts=db.cust.map(c=>`<option value="${c.id}" ${c.id===cid?'selected':''}>${esc(c.name)}</option>`).join('');
  sheetCtx={type:'pay',mode:'Cash',side:'pakka'};
  openSheet(t('add_payment'),`<label class="f"><span>${t('customer')}</span><select class="in" id="payCust">${opts}</select></label>
   <label class="f"><span>${t('amount')}</span><span class="unit"><input class="in big" id="payAmt" inputmode="decimal" placeholder="0"><i>₹</i></span></label>
   <div><div class="xs muted" style="font-weight:600;margin-bottom:5px">${t('how_paid')}</div><div class="seg" id="payMode">${MODES.map((m,k)=>`<button class="${k===0?'on':''}" data-act="payModeSel" data-m="${m}">${m}</button>`).join('')}</div></div>
   <div><div class="xs muted" style="font-weight:600;margin-bottom:5px">${t('applies_to')}</div><div class="seg" id="paySide"><button class="on" data-act="paySideSel" data-s="pakka">${t('pakka')}</button>${can('kacha')?`<button data-act="paySideSel" data-s="kacha">${t('kacha')}</button>`:''}</div></div>
   <label class="f"><span>${t('pay_note')}</span><input class="in" id="payNote" placeholder="${t('pay_note_ph')}"></label>`,
   `<button class="btn b-green" data-act="savePay">${t('save')}</button>`);
}

/* ============ actions ============ */
const ACT={
  back:()=>back(),
  lang:()=>{db.lang=LANGS[(LANGS.indexOf(db.lang)+1)%3];save();render()},
  setLang:d=>{db.lang=d.l;save();render()},
  go:d=>{const p={};Object.keys(d).forEach(k=>{if(k!=='act'&&k!=='r')p[k]=d[k]});go(d.r,p)},
  closeSheet:()=>closeSheet(),
  newOrder:()=>{startDraft();go('newOrder')},
  editOrder:d=>{startDraft(db.orders.find(o=>o.id==d.id));go('newOrder')},
  ordFilter:d=>{view.p={...view.p,f:d.f};render()},
  ordRange:d=>{view.p={...view.p,range:{...(view.p.range||{}),mode:d.k}};render()},
  ordBill:d=>{view.p={...view.p,bill:d.k};render()},
  khSort:d=>{view.p={...view.p,s:d.s};render()},
  khBucket:d=>{view.p={...view.p,b:view.p.b===d.b?'all':d.b};render()},
  custFilter:d=>{view.p={...view.p,f:d.f};render()},
  stmtF:d=>{view.p={...view.p,f:d.f};render()},
  addItem:()=>{draft.items.push(newItem(draft.cust));render();setTimeout(()=>{const el=$('#it'+(draft.items.length-1));el&&el.scrollIntoView({behavior:'smooth',block:'start'})},30)},
  rmItem:d=>{draft.items.splice(+d.i,1);render()},
  setShape:d=>{const it=draft.items[+d.i];it.shape=d.s;it.d=[];it.rows=[{len:'',pcs:'',cuts:''}];render()},
  addRow:d=>{const it=draft.items[+d.i];it.rows=it.rows||[];it.rows.push({len:'',pcs:'',cuts:''});render();setTimeout(()=>{const el=$('#rows'+d.i);el&&el.lastElementChild&&el.lastElementChild.scrollIntoView({behavior:'smooth',block:'nearest'})},30)},
  rmRow:d=>{const it=draft.items[+d.i];it.rows.splice(+d.j,1);render()},
  toggleWSel:d=>{const o=db.orders.find(x=>x.id==view.p.id),i=+d.i,sel=view.p.wsel?[...view.p.wsel]:[];
    const idx=sel.indexOf(i);
    if(idx>=0)sel.splice(idx,1);
    else{if(sel.length&&o.items[sel[0]].matId!==o.items[i].matId){toast(t('wsel_bad'));return}sel.push(i)}
    view.p={...view.p,wsel:sel};render()},
  wselClear:()=>{view.p={...view.p,wsel:[]};render()},
  wselApply:d=>{const o=db.orders.find(x=>x.id==d.id),sel=view.p.wsel||[];if(sel.length<2)return;
    const wt=Number($('#wselWt').value);if(!(wt>0)){toast(t('wsel_bad'));return}
    const ests=sel.map(i=>{const c=calcItem(o.items[i],'est');return c?c.est:0}),totalEst=ests.reduce((a,b)=>a+b,0);
    sel.forEach((i,k)=>{const share=totalEst>0?ests[k]/totalEst:1/sel.length;o.items[i].aw=Math.round(wt*share*100)/100});
    save();view.p={...view.p,wsel:[]};render();toast(t('wsel_saved'))},
  pickMat:d=>matPickSheet(+d.i),
  pickFam:d=>matPickSheet(sheetCtx.i,d.f,''),
  selMat:d=>{const it=draft.items[+d.i];applyMat(it,d.mat,draft.cust);closeSheet();render()},
  info:d=>infoSheet(d.mat,d.i!==undefined?d.i:null,d.from||null),
  backPick:()=>matPickSheet(sheetCtx.i),
  pickCust:()=>custSheet(),
  selCust:d=>{draft.cust=d.id;draft.items.forEach(it=>{const rr=resolveRate(it.matId,d.id);it.rate=rr.rate;it.special=rr.special});closeSheet();render()},
  addCust:()=>{const n=$('#ncName').value.trim(),ph=$('#ncPhone').value.trim();if(!n){toast(t('need_name'));return}
    const c={id:'c'+uid(),name:n,phone:ph,special:{}};db.cust.push(c);save();if(draft){draft.cust=c.id;closeSheet();render()}else{closeSheet();render()}toast(t('added'))},
  saveOrder:d=>saveOrder(d.a==='1'),
  acceptOrder:d=>{const o=db.orders.find(x=>x.id==d.id);o.status='accepted';o.log.push({at:new Date().toISOString(),by:me().name,k:'accepted'});save();toast(t('accepted_msg',o.slipNo));render()},
  submitWeights:d=>{const o=db.orders.find(x=>x.id==d.id);if(!o.items.every(i=>Number(i.aw)>0)){toast(t('need_weights'));return}
    o.status='weighed';o.log.push({at:new Date().toISOString(),by:me().name,k:'weighed'});save();
    if(can('money')){stack.pop();go('finish',{id:o.id},true)}else{toast(t('weights_saved'));back()}},
  finBill:d=>{const el=$('#partAmt');view.p={...view.p,bill:d.b,paid:el?el.value:view.p.paid};render()},
  payMode:d=>{const el=$('#partAmt');view.p={...view.p,mode:d.m,paid:el?el.value:view.p.paid};render()},
  finPM:d=>{const el=$('#partAmt');view.p={...view.p,pmode:d.m,paid:el?el.value:view.p.paid};render()},
  completeOrder:d=>{
    const o=db.orders.find(x=>x.id==d.id),p=view.p;
    if(!can('kacha'))p.bill='pakka';
    if(!p.bill){toast(t('choose_bill'));return}
    const f=finCalc(o,p);
    if(f.mode==='part'&&!(f.paidNow>0&&f.paidNow<f.B)){toast(t('need_part'));return}
    o.bill=p.bill;o.kachaPct=db.set.kachaPct;o.gstPct=db.set.gstPct;
    db.pays.filter(x=>x.oid===o.id).forEach(x=>x.side=o.bill);
    o.doneAt=new Date().toISOString();
    if(f.paidNow>0)addPay({cust:o.cust,oid:o.id,amt:f.paidNow,mode:p.pmode||'Cash',note:(p.note||'').trim(),side:o.bill,kind:'pay',at:o.doneAt});
    o.pay={mode:f.mode};o.status='done';
    o.inKhata=r2(paidOf(o))!==f.T.total;
    o.log.push({at:o.doneAt,by:me().name,k:'done'});save();
    toast(t('completed_msg',o.slipNo));go('slip',{id:o.id},true)},
  copy:(d)=>{const txt=d.txt;const done=()=>toast(t('copied'));try{navigator.clipboard.writeText(txt).then(done,()=>{fallbackCopy(txt);done()})}catch(e){fallbackCopy(txt);done()}},
  addPayment:d=>paySheet(d.id),addPaymentAny:()=>paySheet(null),
  payModeSel:(d,b)=>{sheetCtx.mode=d.m;[...$('#payMode').children].forEach(x=>x.classList.toggle('on',x===b))},
  paySideSel:(d,b)=>{sheetCtx.side=d.s;[...$('#paySide').children].forEach(x=>x.classList.toggle('on',x===b))},
  savePay:()=>{const amt=Number($('#payAmt').value);if(!(amt>0)){toast(t('need_amount'));return}const note=($('#payNote').value||'').trim();
    addPay({cust:$('#payCust').value,amt,mode:sheetCtx.mode,side:sheetCtx.side,note,kind:'due'});save();closeSheet();toast(t('pay_saved',money(amt)));render()},
  addMat:()=>openSheet(t('add_material'),`<div class="fg"><label class="f full"><span>${t('grade')}</span><input class="in" id="nmName" placeholder="EN31"></label><label class="f full"><span>${t('family')}</span><select class="in" id="nmFam">${Object.keys(FAMILIES).map(f=>`<option value="${f}">${famName(f)}</option>`).join('')}</select></label><label class="f"><span>${t('rate_kg')}</span><input class="in" id="nmSell" inputmode="decimal"></label><label class="f"><span>${t('cut_rate')}</span><input class="in" id="nmCut" inputmode="decimal"></label></div>`,`<button class="btn b-green" data-act="saveMat">${t('save')}</button>`),
  saveMat:()=>{const id=$('#nmName').value.trim().toUpperCase();if(!id||db.mats.some(m=>m.id===id)){toast(t('need_name'));return}
    db.mats.push({id,family:$('#nmFam').value,sell:Number($('#nmSell').value)||0,cut:Number($('#nmCut').value)||0,density:null,active:true,info:null});save();closeSheet();render();toast(t('added'))},
  addSpecial:()=>openSheet(t('add_special'),`<label class="f"><span>${t('customer')}</span><select class="in" id="spC">${db.cust.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label><label class="f"><span>${t('grade')}</span><select class="in" id="spM">${db.mats.map(m=>`<option>${esc(m.id)}</option>`).join('')}</select></label><label class="f"><span>${t('rate_kg')}</span><input class="in" id="spR" inputmode="decimal"></label>`,`<button class="btn b-green" data-act="saveSpecial">${t('save')}</button>`),
  saveSpecial:()=>{const r=Number($('#spR').value);if(!(r>0)){toast(t('need_amount'));return}const c=db.cust.find(x=>x.id===$('#spC').value);c.special=c.special||{};c.special[$('#spM').value]=r;save();closeSheet();render()},
  rmSpecial:d=>{const c=db.cust.find(x=>x.id===d.c);delete c.special[d.m];save();render()},
  togPerm:d=>{const u=db.users.find(x=>x.id===d.u);u.perms[d.p]=!u.perms[d.p];save();const el=document.querySelector(`[data-act=togPerm][data-u="${d.u}"][data-p="${d.p}"]`);if(el){el.classList.toggle('on',u.perms[d.p]);el.setAttribute('aria-checked',!!u.perms[d.p])}},
  addUser:()=>openSheet(t('add_person'),`<label class="f"><span>${t('name')}</span><input class="in" id="nuName"></label><div><div class="xs muted" style="font-weight:600;margin-bottom:5px">${t('role')}</div><select class="in" id="nuRole">${Object.keys(PRESET).map(r=>`<option value="${r}">${roleName(r)}</option>`).join('')}</select></div><div class="small muted">${t('role_note')}</div>`,`<button class="btn b-green" data-act="saveUser">${t('save')}</button>`),
  saveUser:()=>{const n=$('#nuName').value.trim();if(!n){toast(t('need_name'));return}const r=$('#nuRole').value;db.users.push({id:'u'+uid(),name:n,role:r,perms:PRESET[r]()});save();closeSheet();render()},
  togWeight:()=>{db.set.showWeight=!db.set.showWeight;save();render()},
  setNumReset:d=>{db.set.numReset=d.k;save();render()},
  setUnit:d=>{const it=draft.items[+d.i],from=unitOf(it);if(from===d.u)return;it.d=it.d.map(v=>convLen(v,from,d.u));(it.rows||[]).forEach(r=>{r.len=convLen(r.len,from,d.u)});it.unit=d.u;render()},
  useLast:d=>{const it=draft.items[+d.i],L=lastSold(draft.cust,it.matId,draft.id),h=L.mine||L.any;if(!h)return;it.rate=h.rate;it.cutRate=h.cut;it.special=false;render()},
  advMode:d=>{draft.adv.mode=d.m;[...$('#advModeSeg').children].forEach(x=>x.classList.toggle('on',x.dataset.m===d.m))},
  addAdvance:d=>{sheetCtx={type:'adv',mode:'Cash',oid:+d.id};const o=db.orders.find(x=>x.id==d.id);
    openSheet(`${t('adv_add')} · #${o.slipNo}`,`<label class="f"><span>${t('adv_amt')}</span><span class="unit"><input class="in big" id="advAmt2" inputmode="decimal" placeholder="0"><i>₹</i></span></label>
     <div><div class="xs muted" style="font-weight:600;margin-bottom:5px">${t('pay_via')}</div><div class="seg" id="advMode2">${MODES.map((m,k)=>`<button class="${k===0?'on':''}" data-act="advModeSel" data-m="${m}">${m}</button>`).join('')}</div></div>
     <label class="f"><span>${t('pay_note')}</span><input class="in" id="advNote2" placeholder="${t('pay_note_ph')}"></label>`,
     `<button class="btn b-green" data-act="saveAdvance">${t('save')}</button>`)},
  advModeSel:(d,b)=>{sheetCtx.mode=d.m;[...$('#advMode2').children].forEach(x=>x.classList.toggle('on',x===b))},
  saveAdvance:()=>{const amt=Number($('#advAmt2').value);if(!(amt>0)){toast(t('need_amount'));return}const o=db.orders.find(x=>x.id===sheetCtx.oid);const note=($('#advNote2').value||'').trim();
    addPay({cust:o.cust,oid:o.id,amt,mode:sheetCtx.mode,note,kind:'advance'});save();closeSheet();toast(t('adv_saved',money(amt)));render()},
  setUnitDef:d=>{db.set.unit=d.u;save();render()},
  openGuide:()=>go('guide',{q:'',focus:true}),
  gset:d=>{view.p={...view.p,q:d.q};render();const el=$('#gq');if(el)el.setSelectionRange(el.value.length,el.value.length)},
  askStop:()=>{if(askCtl)askCtl.abort()},
  askAI:async()=>{
    if(!SAMPLE)return;
    const q=(($('#askq')||{}).value||'').trim();
    if(!q){toast(t('g_type_q'));return}
    const out=$('#askout'),note=$('#asknote'),btn=$('#askbtn'),stop=$('#askstop');
    if(!out)return;
    out.style.display='block';out.textContent=t('g_thinking');if(note)note.style.display='none';btn.disabled=true;stop.style.display='inline-flex';
    askCtl=new AbortController();
    const live=()=>document.body.contains(out);
    try{
      const r=await SAMPLE(askPrompt(q),{modelTier:'quick',cache:false,signal:askCtl.signal,onText:u=>{if(live())out.textContent=u.text}});
      guideAns={q,text:r.text+(r.truncated?' …':'')};
      if(live()){out.textContent=guideAns.text;if(note)note.style.display='block'}
    }catch(e){
      const c=e&&e.code;if(!live())return;
      if(c==='cancelled'){out.textContent=(e.text||'')||t('g_stopped')}
      else out.textContent=(e&&e.text?e.text+'\n\n':'')+(c==='not_granted'||c==='sampling_disabled'?t('g_denied'):c==='rate_limited'?t('g_limit'):t('g_error'));
    }finally{if(live()){btn.disabled=false;stop.style.display='none'}}
  },
  resetDemo:()=>{const l=db.lang;seedDb();db.lang=l;save();stack=[];view={r:'home',p:{}};render();toast(t('reset_done'))},
  saveCashClose:()=>{const el=$('#cashCount');const counted=Number(el&&el.value)||0;const key=new Date().toISOString().slice(0,10);
    db.cashClose=db.cashClose||{};db.cashClose[key]={expected:moneyByMode().Cash||0,counted,by:me().name,at:new Date().toISOString()};
    save();view.p.cc=null;toast(t('cash_saved'));render()}
};
function fallbackCopy(txt){const ta=document.createElement('textarea');ta.value=txt;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();try{document.execCommand('copy')}catch(e){}ta.remove()}

/* input handlers (no full re-render, so typing keeps focus) */
const INP={
  dim:el=>{const it=draft.items[+el.dataset.i];it.d[+el.dataset.j]=el.value;refreshDraft(+el.dataset.i)},
  rlen:el=>{draft.items[+el.dataset.i].rows[+el.dataset.j].len=el.value;refreshDraft(+el.dataset.i)},
  rpcs:el=>{const it=draft.items[+el.dataset.i],j=+el.dataset.j;it.rows[j].pcs=el.value;refreshDraft(+el.dataset.i);const c=el.closest('.rowline').querySelector('[data-inp=rcuts]');if(c)c.placeholder=el.value||'auto'},
  rcuts:el=>{draft.items[+el.dataset.i].rows[+el.dataset.j].cuts=el.value;refreshDraft(+el.dataset.i)},
  rgDate:el=>{view.p={...view.p,range:{...(view.p.range||{}),date:el.value}};render()},
  rgMonth:el=>{view.p={...view.p,range:{...(view.p.range||{}),month:el.value}};render()},
  rgFrom:el=>{view.p={...view.p,range:{...(view.p.range||{}),from:el.value}};render()},
  rgTo:el=>{view.p={...view.p,range:{...(view.p.range||{}),to:el.value}};render()},
  rate:el=>{const it=draft.items[+el.dataset.i];it.rate=el.value;it.special=false;refreshDraft(+el.dataset.i)},
  crate:el=>{draft.items[+el.dataset.i].cutRate=el.value;refreshDraft(+el.dataset.i)},
  aw:el=>{const o=db.orders.find(x=>x.id==view.p.id);o.items[+el.dataset.i].aw=el.value===''?null:el.value;save();refreshWeigh(o,+el.dataset.i)},
  part:el=>{view.p.paid=el.value;const o=db.orders.find(x=>x.id==view.p.id),n=$('#finNote');if(n){n.textContent=finNote(o,view.p)}},
  advAmt:el=>{draft.adv.amt=el.value},
  advNote:el=>{draft.adv.note=el.value},
  finPNote:el=>{view.p.note=el.value},
  cashCount:el=>{view.p.cc=el.value;const d=$('#cashDiff');if(d)d.innerHTML=cashDiffHtml(Number(el.value)||0,moneyByMode().Cash||0)},
  gq:el=>{view.p.q=el.value;const r=$('#gres');if(r)r.innerHTML=guideResults(el.value)},  kq:el=>{view.p.q=el.value;const pos=el.selectionStart;render();const n=document.querySelector('[data-inp=kq]');if(n){n.focus();n.setSelectionRange(pos,pos)}},
  mq:el=>matPickSheet(sheetCtx.i,sheetCtx.fam,el.value),
  cq:el=>custSheet(el.value),
  msell:el=>{db.mats[+el.dataset.i].sell=Number(el.value)||0;save()},
  mcut:el=>{db.mats[+el.dataset.i].cut=Number(el.value)||0;save()},
  mden:el=>{db.mats[+el.dataset.i].density=el.value===''?null:Number(el.value);save()},
  famd:el=>{const v=Number(el.value);if(v>0){FAMILIES[el.dataset.f].d=v;db.fam=db.fam||{};db.fam[el.dataset.f]=v;save()}},
  s_kachaPct:el=>{db.set.kachaPct=Number(el.value)||0;save()},
  s_minInch:el=>{db.set.minInch=Number(el.value)||0;save()},
  s_gstPct:el=>{db.set.gstPct=Number(el.value)||0;save()},
  s_warnPct:el=>{db.set.warnPct=Number(el.value)||0;save()},
  s_shopname:el=>{db.set.shop.name=el.value;save()},s_shopphone:el=>{db.set.shop.phone=el.value;save()},s_shopgst:el=>{db.set.shop.gst=el.value;save()}
};
const CHG={me:el=>{db.me=el.value;save();render()}};
document.addEventListener('click',e=>{const b=e.target.closest('[data-act]');if(!b)return;const f=ACT[b.dataset.act];if(f){if(b.tagName==='A'&&b.dataset.act==='')return;f(b.dataset,b,e)}});
document.addEventListener('input',e=>{const f=e.target.dataset&&e.target.dataset.inp&&INP[e.target.dataset.inp];if(f)f(e.target)});
document.addEventListener('change',e=>{const f=e.target.dataset&&e.target.dataset.chg&&CHG[e.target.dataset.chg];if(f)f(e.target)});
load();render();
