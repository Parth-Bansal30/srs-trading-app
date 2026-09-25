'use strict';
/* ============ basics ============ */
const LANGS=['en','hi','hn'],LANG_LABEL={en:'EN',hi:'हिं',hn:'Hn'},LOCALE={en:'en-IN',hi:'hi-IN',hn:'en-IN'};
const KEY='srs-steel-desk-v2';
const MODES=['Cash','UPI','Bank','Cheque'];
const PERMS=['new','orders','weigh','khata','today','rates','people','settings','money','kacha'];
const allOn=()=>Object.fromEntries(PERMS.map(p=>[p,true]));
const PRESET={owner:allOn,sales:()=>({new:1,orders:1,money:1,kacha:1}),weigher:()=>({weigh:1,orders:1}),accounts:()=>({orders:1,khata:1,today:1,money:1})};
const FAMILIES={carbon:{d:7850},alloy:{d:7850},stainless:{d:7930},tool:{d:7700}};
const PI=Math.PI,HEX=Math.sqrt(3)/2;
const SHAPES={
  square:{dims:['side'],len:true,vol:(d,L)=>d[0]*d[0]*L,face:i=>i[0]*i[0],sides:d=>[d[0]]},
  round:{dims:['dia'],len:true,vol:(d,L)=>PI/4*d[0]*d[0]*L,face:i=>PI/4*i[0]*i[0],sides:d=>[d[0]]},
  flat:{dims:['width','thick'],len:true,vol:(d,L)=>d[0]*d[1]*L,face:i=>i[0]*i[1],sides:d=>[d[0],d[1]]},
  block:{dims:['width','height'],len:true,vol:(d,L)=>d[0]*d[1]*L,face:i=>i[0]*i[1],sides:d=>[d[0],d[1]]},
  hex:{dims:['af'],len:true,vol:(d,L)=>HEX*d[0]*d[0]*L,face:i=>HEX*i[0]*i[0],sides:d=>[d[0]]},
  plate:{dims:['plen','pwid','thick'],len:false,vol:d=>d[0]*d[1]*d[2],face:i=>i[0]*i[1],sides:d=>[d[1],d[2]]}
};
const SHAPE_IDS=Object.keys(SHAPES);
let db=null;
const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const r2=x=>Math.round((x+Number.EPSILON)*100)/100;
const fmt=(n,d=0)=>Number(n).toLocaleString('en-IN',{minimumFractionDigits:d,maximumFractionDigits:d});
const money=n=>{n=r2(Number(n)||0);return '₹'+(Number.isInteger(n)?fmt(n,0):fmt(n,2))};
const money2=n=>'₹'+fmt(r2(Number(n)||0),2);
const kg=n=>fmt(n,2)+' kg';
const t=(k,...a)=>{const v=S[k];if(!v)return k;let s=v[LANGS.indexOf(db?db.lang:'en')]??v[0];a.forEach((x,i)=>{s=s.split('{'+i+'}').join(x)});return s};
const pick=arr=>arr[Math.max(0,LANGS.indexOf(db.lang))]??arr[0];
const dfmt=(iso,o={day:'numeric',month:'short'})=>new Date(iso).toLocaleDateString(LOCALE[db.lang],o);
const tfmt=iso=>new Date(iso).toLocaleTimeString(LOCALE[db.lang],{hour:'2-digit',minute:'2-digit'});
const sameDay=(a,b)=>new Date(a).toDateString()===new Date(b).toDateString();
const daysSince=iso=>Math.max(0,Math.floor((Date.now()-new Date(iso).getTime())/86400000));
const uid=()=>Math.random().toString(36).slice(2,8);
function save(){try{localStorage.setItem(KEY,JSON.stringify(db))}catch(e){}}

/* ============ materials (SAMPLE data, editable in Rates) ============ */
const tri=(a,b,c)=>[a,b,c];
function seedMats(){
  const M=(id,family,sell,cut,over,info)=>({id,family,sell,cut,density:over||null,active:true,info});
  return [
  M('MS','carbon',58,2,null,{eq:'IS 2062 / A36 type',
    what:tri('Low-carbon steel. Soft, easy to cut, bend and weld. It does not get much harder with heat treatment.','कम कार्बन वाला स्टील। नरम है, काटना, मोड़ना और वेल्ड करना आसान। हीट ट्रीटमेंट से ज़्यादा सख़्त नहीं होता।','Kam carbon wala steel. Naram hai, kaatna, modna aur weld karna aasaan. Heat treatment se zyada sakht nahi hota.'),
    good:[['Frames and brackets','Base plates','General fabrication','Structures'],['फ्रेम और ब्रैकेट','बेस प्लेट','आम फैब्रिकेशन','ढांचे'],['Frame aur bracket','Base plate','Aam fabrication','Dhaancha']],
    watch:tri('Rusts if left unprotected. Not for shafts that carry heavy load.','सुरक्षा न हो तो ज़ंग लगता है। भारी लोड वाले शाफ्ट के लिए नहीं।','Suraksha na ho to zang lagta hai. Bhaari load wale shaft ke liye nahi.'),
    alts:[['EN8',tri('Stronger. Use when the part carries load.','ज़्यादा मज़बूत। लोड वाले पार्ट के लिए।','Zyada mazboot. Load wale part ke liye.')]]}),
  M('EN8','carbon',75,3,null,{eq:'≈ C45 / 1045 / 080M40',
    what:tri('Medium-carbon steel (about 0.4% carbon). Good strength, machines well, and the surface can be hardened. The most common all-round shaft steel.','मध्यम कार्बन स्टील (लगभग 0.4% कार्बन)। अच्छी मज़बूती, आसानी से मशीन होता है, ऊपरी सतह सख़्त की जा सकती है। शाफ्ट के लिए सबसे आम स्टील।','Madhyam carbon steel (lagbhag 0.4% carbon). Achhi mazbooti, aasaani se machine hota hai, upar ki satah sakht ho sakti hai. Shaft ke liye sabse aam steel.'),
    good:[['Shafts and axles','Bolts and studs','Pins and keys','Light-duty gears'],['शाफ्ट और एक्सल','बोल्ट और स्टड','पिन और की','हल्के गियर'],['Shaft aur axle','Bolt aur stud','Pin aur key','Halke gear']],
    watch:tri('Not for very heavy or shock loads. Go to EN19 or EN24 for those.','बहुत भारी या झटके वाले लोड के लिए नहीं। उसके लिए EN19 या EN24 लें।','Bahut bhaari ya jhatke wale load ke liye nahi. Uske liye EN19 ya EN24 lo.'),
    alts:[['EN9',tri('A bit harder and stronger (more carbon).','थोड़ा ज़्यादा सख़्त और मज़बूत (ज़्यादा कार्बन)।','Thoda zyada sakht aur mazboot (zyada carbon).')],['EN19',tri('Much stronger alloy steel. Costs more.','बहुत मज़बूत अलॉय स्टील। दाम ज़्यादा।','Bahut mazboot alloy steel. Daam zyada.')]]}),
  M('EN9','carbon',78,3,null,{eq:'≈ 070M55 / C55',
    what:tri('Higher-carbon steel (about 0.5 to 0.6% carbon). Harder and more wear-resistant than EN8, a little harder to machine.','ज़्यादा कार्बन वाला स्टील (लगभग 0.5 से 0.6%)। EN8 से सख़्त और घिसाव सहने वाला, मशीन करना थोड़ा मुश्किल।','Zyada carbon wala steel (lagbhag 0.5 se 0.6%). EN8 se sakht aur ghisaav sehne wala, machine karna thoda mushkil.'),
    good:[['Gears and sprockets','Shafts with more wear','Cams','Rollers'],['गियर और स्प्रोकेट','ज़्यादा घिसने वाले शाफ्ट','कैम','रोलर'],['Gear aur sprocket','Zyada ghisne wale shaft','Cam','Roller']],
    watch:tri('Can crack if heated and cooled badly. Weld only with care.','गलत तरीके से गरम-ठंडा करने पर फट सकता है। वेल्डिंग सावधानी से।','Galat tareeke se garam-thanda karne par phat sakta hai. Welding savdhani se.'),
    alts:[['EN8',tri('Easier to machine and cheaper.','मशीन करना आसान और सस्ता।','Machine karna aasaan aur sasta.')],['EN19',tri('Stronger and tougher alloy steel.','ज़्यादा मज़बूत और टिकाऊ अलॉय स्टील।','Zyada mazboot aur tikaau alloy steel.')]]}),
  M('EN19','alloy',92,4,null,{eq:'≈ 4140 / 42CrMo4 / 605M36',
    what:tri('Chromium-molybdenum alloy steel. High strength, good toughness and long fatigue life. Often supplied hardened and tempered.','क्रोम-मोली अलॉय स्टील। ज़्यादा मज़बूती, अच्छी टिकाऊपन और थकान सहने की क्षमता। अक्सर हार्डन और टेम्पर करके मिलता है।','Chrome-moly alloy steel. Zyada mazbooti, achha tikaaupan aur thakaan sehne ki kshamta. Aksar harden aur temper karke milta hai.'),
    good:[['High-strength shafts','Spindles','Studs and bolts','Gears','Hydraulic parts'],['ज़्यादा मज़बूत शाफ्ट','स्पिंडल','स्टड और बोल्ट','गियर','हाइड्रोलिक पार्ट'],['Zyada mazboot shaft','Spindle','Stud aur bolt','Gear','Hydraulic part']],
    watch:tri('Harder to machine than EN8. Pre-heat before welding.','EN8 से मशीन करना मुश्किल। वेल्डिंग से पहले गरम करें।','EN8 se machine karna mushkil. Welding se pehle garam karo.'),
    alts:[['EN24',tri('Stronger, hardens deeper. Costs more.','ज़्यादा मज़बूत, गहराई तक सख़्त। दाम ज़्यादा।','Zyada mazboot, gehraai tak sakht. Daam zyada.')],['EN8',tri('Fine if the strength needed is lower. Cheaper.','कम मज़बूती चाहिए तो ठीक। सस्ता।','Kam mazbooti chahiye to theek. Sasta.')]]}),
  M('EN24','alloy',95,4,null,{eq:'≈ 4340 / 817M40',
    what:tri('Nickel-chromium-molybdenum alloy steel. Very high strength and toughness, and it hardens deep even in thick sections.','निकल-क्रोम-मोली अलॉय स्टील। बहुत ज़्यादा मज़बूती और टिकाऊपन, मोटे साइज़ में भी गहराई तक सख़्त होता है।','Nickel-chrome-moly alloy steel. Bahut zyada mazbooti aur tikaaupan, mote size mein bhi gehraai tak sakht hota hai.'),
    good:[['Heavy-duty shafts','Crankshafts','Connecting rods','Large gears','High-stress parts'],['भारी शाफ्ट','क्रैंकशाफ्ट','कनेक्टिंग रॉड','बड़े गियर','ज़्यादा दबाव वाले पार्ट'],['Bhaari shaft','Crankshaft','Connecting rod','Bade gear','Zyada dabaav wale part']],
    watch:tri('Costs more than EN19. It needs proper heat treatment to give its full strength.','EN19 से महंगा। पूरी मज़बूती के लिए सही हीट ट्रीटमेंट चाहिए।','EN19 se mehnga. Poori mazbooti ke liye sahi heat treatment chahiye.'),
    alts:[['EN19',tri('One step lower in strength, but cheaper.','मज़बूती थोड़ी कम, पर सस्ता।','Mazbooti thodi kam, par sasta.')]]}),
  M('EN31','alloy',110,4,null,{eq:'≈ 52100 / 100Cr6',
    what:tri('High-carbon chromium steel. Becomes very hard and wear-resistant after hardening.','ज़्यादा कार्बन वाला क्रोम स्टील। हार्डन करने के बाद बहुत सख़्त और घिसाव सहने वाला।','Zyada carbon wala chrome steel. Harden karne ke baad bahut sakht aur ghisaav sehne wala.'),
    good:[['Bearings and rollers','Bushes','Wear parts','Light-duty punches and dies'],['बेयरिंग और रोलर','बुश','घिसने वाले पार्ट','हल्के पंच और डाई'],['Bearing aur roller','Bush','Ghisne wale part','Halke punch aur die']],
    watch:tri('Becomes brittle if hardened too much. Not for welding.','ज़्यादा सख़्त करने पर टूटने वाला हो जाता है। वेल्डिंग के लिए नहीं।','Zyada sakht karne par tootne wala ho jaata hai. Welding ke liye nahi.'),
    alts:[['D2',tri('Even more wear-resistant, for tools. Costs more.','और ज़्यादा घिसाव सहने वाला, टूल के लिए। महंगा।','Aur zyada ghisaav sehne wala, tool ke liye. Mehnga.')],['EN24',tri('Tougher, but not as wear-resistant.','ज़्यादा टिकाऊ, पर घिसाव कम सहता है।','Zyada tikaau, par ghisaav kam sehta hai.')]]}),
  M('EN36','alloy',120,4,null,{eq:'≈ 655M13 / 15NiCr13',
    what:tri('Case-hardening steel. Tough soft core with a very hard surface after carburising.','केस-हार्डनिंग स्टील। अंदर से नरम और मज़बूत, कार्बराइज़ करने के बाद ऊपर से बहुत सख़्त।','Case-hardening steel. Andar se naram aur mazboot, carburise karne ke baad upar se bahut sakht.'),
    good:[['Gears and pinions','Camshafts','Shafts that need a hard surface'],['गियर और पिनियन','कैमशाफ्ट','सख़्त सतह वाले शाफ्ट'],['Gear aur pinion','Camshaft','Sakht satah wale shaft']],
    watch:tri('Meant for case-hardening jobs. If the drawing says through-hardened, use EN19 or EN24 instead.','केस-हार्डनिंग वाले काम के लिए। ड्रॉइंग में थ्रू-हार्डन लिखा हो तो EN19 या EN24 लें।','Case-hardening wale kaam ke liye. Drawing mein through-harden likha ho to EN19 ya EN24 lo.'),
    alts:[]}),
  M('D2','tool',260,6,null,{eq:'≈ 1.2379 / HCHCr',
    what:tri('High-carbon, high-chromium tool steel. Very high wear resistance and holds a sharp edge.','ज़्यादा कार्बन, ज़्यादा क्रोम वाला टूल स्टील। बहुत घिसाव सहता है और धार टिकाए रखता है।','Zyada carbon, zyada chrome wala tool steel. Bahut ghisaav sehta hai aur dhaar tikaaye rakhta hai.'),
    good:[['Dies and punches','Shear blades','Cutting and forming tools'],['डाई और पंच','शियर ब्लेड','कटिंग और फॉर्मिंग टूल'],['Die aur punch','Shear blade','Cutting aur forming tool']],
    watch:tri('Costly and hard to machine. Not for parts that face heavy shock.','महंगा और मशीन करना मुश्किल। भारी झटके वाले पार्ट के लिए नहीं।','Mehnga aur machine karna mushkil. Bhaari jhatke wale part ke liye nahi.'),
    alts:[['EN31',tri('Cheaper, but wears faster.','सस्ता, पर जल्दी घिसता है।','Sasta, par jaldi ghista hai.')]]}),
  M('SS304','stainless',235,6,null,{eq:'≈ 1.4301 / 18-8',
    what:tri('The common stainless steel (about 18% chromium, 8% nickel). Resists rust, easy to clean and weld. It cannot be hardened by heat treatment.','आम स्टेनलेस स्टील (लगभग 18% क्रोम, 8% निकल)। ज़ंग नहीं लगता, साफ़ करना और वेल्ड करना आसान। हीट ट्रीटमेंट से सख़्त नहीं होता।','Aam stainless steel (lagbhag 18% chrome, 8% nickel). Zang nahi lagta, saaf karna aur weld karna aasaan. Heat treatment se sakht nahi hota.'),
    good:[['Food and dairy equipment','Kitchen ware','Tanks','Railings','General stainless work'],['फ़ूड और डेयरी उपकरण','किचन का सामान','टंकी','रेलिंग','आम स्टेनलेस काम'],['Food aur dairy equipment','Kitchen ka saamaan','Tanki','Railing','Aam stainless kaam']],
    watch:tri('Not for strong salt or chemical exposure (use SS316). It hardens while cutting, so use a sharp blade and steady feed.','ज़्यादा नमक या केमिकल वाली जगह के लिए नहीं (SS316 लें)। कटते समय सख़्त होता है, इसलिए तेज़ ब्लेड और एक जैसी रफ़्तार रखें।','Zyada namak ya chemical wali jagah ke liye nahi (SS316 lo). Katte samay sakht hota hai, isliye tez blade aur ek jaisi raftaar rakho.'),
    alts:[['SS316',tri('Better against salt and chemicals. Costs more.','नमक और केमिकल के लिए बेहतर। महंगा।','Namak aur chemical ke liye behtar. Mehnga.')]]}),
  M('SS316','stainless',340,7,7980,{eq:'≈ 1.4401 / 316',
    what:tri('Stainless steel with molybdenum added. Much better than SS304 against salt water and chemicals.','मोलिब्डेनम मिला स्टेनलेस स्टील। नमकीन पानी और केमिकल में SS304 से काफ़ी बेहतर।','Molybdenum mila stainless steel. Namkeen paani aur chemical mein SS304 se kaafi behtar.'),
    good:[['Marine fittings','Chemical and pharma equipment','Coastal outdoor use'],['समुद्री फिटिंग','केमिकल और फार्मा उपकरण','समुद्र किनारे बाहर का काम'],['Samudri fitting','Chemical aur pharma equipment','Samudra kinare bahar ka kaam']],
    watch:tri('Costs more than SS304. Same care while cutting.','SS304 से महंगा। कटिंग में वही सावधानी।','SS304 se mehnga. Cutting mein wahi savdhani.'),
    alts:[['SS304',tri('Fine for mild conditions. Cheaper.','हल्की स्थिति में ठीक। सस्ता।','Halki sthiti mein theek. Sasta.')]]})
  ];
}
const matById=id=>db.mats.find(m=>m.id===id);
const densOf=m=>m?(m.density??FAMILIES[m.family]?.d??null):null;

/* ============ engine ============ */
const inchOf=mm=>{let x=Math.floor(mm/25.4+0.5+1e-9);const m=Number(db.set.minInch)||0;if(m>0)x=Math.max(x,m);return x};
/* sizes may be typed as 2.5 or 2 1/2 or 1/2 */
function parseLen(v){
  if(typeof v==='number')return v;
  const s=String(v??'').trim();if(!s)return NaN;
  const m=s.match(/^(?:(\d+)[\s-]+)?(\d+)\/(\d+)$/);
  if(m){const den=Number(m[3]);return den?(m[1]?Number(m[1]):0)+Number(m[2])/den:NaN}
  return Number(s);
}
const unitOf=it=>it&&it.unit==='in'?'in':'mm';
const toMm=(v,unit)=>{const n=parseLen(v);return unit==='in'?n*25.4:n};
function convLen(v,from,to){
  if(from===to||v===''||v==null)return v;
  const n=parseLen(v);if(!(n>=0))return v;
  const mm=from==='in'?n*25.4:n;
  return to==='in'?String(+(mm/25.4).toFixed(3)):String(+mm.toFixed(2));
}
function resolveRate(matId,custId){const c=db.cust.find(x=>x.id===custId);const m=matById(matId);const sp=c&&c.special&&c.special[matId];return sp!=null&&sp!==''?{rate:Number(sp),special:true}:{rate:m?m.sell:0,special:false}}
/* the last time this grade was sold: to this customer, else to anyone */
function lastSold(custId,matId,excludeId){
  const pool=db.orders.filter(o=>o.id!==excludeId&&o.status!=='estimate');
  const find=list=>{let best=null;list.forEach(o=>o.items.forEach(it=>{if(it.matId===matId&&Number(it.rate)>0&&(!best||new Date(o.at)>new Date(best.at)))best={at:o.at,rate:Number(it.rate),cut:Number(it.cutRate)||0,id:o.id,cust:o.cust}}));return best};
  const mine=custId?find(pool.filter(o=>o.cust===custId)):null;
  return {mine,any:mine?null:find(pool)};
}
function calcItem(it,mode){
  const sh=SHAPES[it.shape];if(!sh)return null;
  const u=unitOf(it);
  const d=(it.d||[]).map(v=>toMm(v,u));
  if(d.length<sh.dims.length||d.slice(0,sh.dims.length).some(v=>!(v>0)))return null;
  const den=Number(it.density);if(!(den>0))return null;
  const rowsIn=(it.rows&&it.rows.length)?it.rows:[{len:it.len,pcs:it.pcs,cuts:it.cuts}];
  const rows=[];
  for(const r of rowsIn){
    const L=sh.len?toMm(r.len,u):0;
    if(sh.len&&!(L>0))return null;
    const pcs=Math.floor(Number(r.pcs));if(!(pcs>0))return null;
    const perPc=sh.vol(d,L)*den/1e9;
    const auto=!(r.cuts!=null&&r.cuts!=='');
    const cuts=auto?pcs:Math.max(0,Math.floor(Number(r.cuts)));
    rows.push({len:r.len,L,pcs,perPc,est:perPc*pcs,cuts,auto});
  }
  const est=rows.reduce((a,r)=>a+r.est,0);
  const pcs=rows.reduce((a,r)=>a+r.pcs,0);
  const totalCuts=rows.reduce((a,r)=>a+r.cuts,0);
  const useAct=mode==='final'&&Number(it.aw)>0;
  const weight=useAct?Number(it.aw):est;
  const rate=Number(it.rate)||0,cr=Number(it.cutRate)||0;
  const mat=r2(weight*rate);
  const sides=sh.sides(d).map(mm=>({mm,raw:mm/25.4,inch:inchOf(mm)}));
  const area=sh.face(sides.map(s=>s.inch));
  const cut=r2(area*cr*totalCuts);
  return {rows,est,weight,useAct,mat,cut,total:r2(mat+cut),sides,area,cuts:totalCuts,pcs,rate,cr,L:rows[0]?rows[0].L:0};
}
/* bill: 'pakka' adds GST, 'kacha' adds the local %, null = plain amount (bill not chosen yet) */
function orderTotals(o,mode,billOv){
  let mat=0,cut=0,wt=0,ok=false;
  (o.items||[]).forEach(it=>{const c=calcItem(it,mode);if(c){mat+=c.mat;cut+=c.cut;wt+=c.weight;ok=true}});
  mat=r2(mat);cut=r2(cut);const base=r2(mat+cut);
  const bill=billOv!==undefined?billOv:o.bill;
  let matK=mat,cutK=cut,gst=0,pct=0;
  if(bill==='kacha'){pct=o.kachaPct??db.set.kachaPct;const f=1+pct/100;matK=r2(mat*f);cutK=r2(cut*f)}
  else if(bill==='pakka'){pct=o.gstPct??db.set.gstPct;gst=r2(base*pct/100)}
  const total=r2(matK+cutK+gst);
  return {mat,cut,base,matK,cutK,gst,total,adj:r2(total-base),pct,wt,ok,bill};
}
const finalTotal=o=>orderTotals(o,o.status==='estimate'||o.status==='accepted'?'est':'final');
/* payments: {id,cust,at,amt,mode,side,oid,kind}  kind = advance | pay (at pickup) | due (later, from the Khata) */
function addPay(p){db.pays.push({id:'p'+(db.npay++),at:new Date().toISOString(),oid:null,side:null,kind:'due',...p,amt:r2(p.amt)})}
const paysOf=oid=>db.pays.filter(p=>p.oid===oid);
const advOf=o=>r2(db.pays.filter(p=>p.oid===o.id&&p.kind==='advance').reduce((a,p)=>a+p.amt,0));
const paidOf=o=>r2(paysOf(o.id).reduce((a,p)=>a+p.amt,0));
/* what was still unpaid the moment the order was finished */
function dueOf(o){if(o.status!=='done')return 0;return r2(Math.max(0,orderTotals(o,'final').total-paidOf(o)))}
const me=()=>db.users.find(u=>u.id===db.me)||db.users[0];
const can=p=>!!me().perms[p];
const visSides=()=>can('kacha')?['pakka','kacha']:['pakka'];
const visOrders=()=>db.orders.filter(o=>!o.bill||visSides().includes(o.bill));
const byDate=(a,b)=>new Date(a.date)-new Date(b.date);
function ledger(cid,sides=visSides()){
  const full=sides.length===visSides().length;
  const orders=db.orders.filter(o=>o.cust===cid&&o.status==='done'&&o.inKhata&&sides.includes(o.bill));
  const ids=new Set(orders.map(o=>o.id));
  const bills=orders.map(o=>({t:'bill',date:o.doneAt||o.at,side:o.bill,amt:orderTotals(o,'final').total,oid:o.id}));
  const pay=p=>({t:'pay',date:p.at,side:p.side,amt:p.amt,mode:p.mode,note:p.note,kind:p.kind,oid:p.oid,pid:p.id});
  const linked=db.pays.filter(p=>p.cust===cid&&p.oid&&ids.has(p.oid)).map(pay);
  const loose=db.pays.filter(p=>p.cust===cid&&!p.oid&&sides.includes(p.side)).map(pay);
  const pend=full?db.pays.filter(p=>{if(p.cust!==cid||!p.oid||p.kind!=='advance')return false;const o=db.orders.find(x=>x.id===p.oid);return o&&o.status!=='done'}).map(p=>({...pay(p),pending:true})):[];
  const out={bills,pays:[...linked,...loose,...pend],oldest:null,bySide:{},due:0,adv:0,pend:0};
  const sum=a=>r2(a.reduce((x,y)=>x+y.amt,0));
  sides.forEach(sd=>{
    const bs=bills.filter(b=>b.side===sd).sort(byDate);
    let pool=0;
    bs.forEach(b=>{const lk=sum(linked.filter(p=>p.oid===b.oid));b.rem=r2(Math.max(0,b.amt-lk));pool=r2(pool+Math.max(0,lk-b.amt))});
    pool=r2(pool+sum(loose.filter(p=>p.side===sd)));
    let dueSide=0;
    bs.forEach(b=>{if(b.rem>0){const use=Math.min(pool,b.rem);pool=r2(pool-use);b.rem=r2(b.rem-use)}b.paid=r2(b.amt-b.rem);dueSide+=b.rem;
      if(b.rem>0&&(!out.oldest||new Date(b.date)<new Date(out.oldest)))out.oldest=b.date});
    out.bySide[sd]={due:r2(dueSide),adv:pool};
  });
  out.pend=sum(pend);
  out.due=r2(Object.values(out.bySide).reduce((a,x)=>a+x.due,0));
  out.adv=r2(Object.values(out.bySide).reduce((a,x)=>a+x.adv,0)+out.pend);
  const entries=[...bills,...out.pays].sort(byDate);
  let run=0;entries.forEach(e=>{run=r2(run+(e.t==='bill'?e.amt:-e.amt));e.bal=run});
  out.entries=entries;return out;
}
function khataList(){
  return db.cust.map(c=>({c,l:ledger(c.id)})).filter(x=>x.l.due>0||x.l.adv>0);
}
function summaryToday(){
  const now=new Date().toISOString(),vs=visSides();
  const vo=visOrders();
  const created=vo.filter(o=>sameDay(o.at,now));
  const done=vo.filter(o=>o.status==='done'&&sameDay(o.doneAt||o.at,now));
  let pk=0,kc=0,fromAdv=0,khata=0;
  done.forEach(o=>{const tt=orderTotals(o,'final').total;if(o.bill==='kacha')kc+=tt;else pk+=tt;fromAdv+=Math.min(advOf(o),tt);khata+=dueOf(o)});
  const vis=p=>p.side==null||vs.includes(p.side);
  const today=db.pays.filter(p=>sameDay(p.at,now)&&vis(p));
  const sumK=k=>r2(today.filter(p=>p.kind===k).reduce((a,p)=>a+p.amt,0));
  const spot=sumK('pay'),advTaken=sumK('advance'),collected=sumK('due');
  return {n:created.length,done:done.length,toWeigh:vo.filter(o=>o.status==='accepted').length,ready:vo.filter(o=>o.status==='weighed').length,est:vo.filter(o=>o.status==='estimate').length,
    pk:r2(pk),kc:r2(kc),total:r2(pk+kc),spot,fromAdv:r2(fromAdv),khata:r2(khata),advTaken,collected,moneyIn:r2(spot+advTaken+collected)};
}
/* how much of today's money came in by each mode (cash / UPI / bank / cheque) */
function moneyByMode(){
  const now=new Date().toISOString(),vs=visSides();
  const vis=p=>p.side==null||vs.includes(p.side);
  const today=db.pays.filter(p=>sameDay(p.at,now)&&vis(p));
  const out={};MODES.forEach(m=>out[m]=0);
  today.forEach(p=>{out[p.mode]=r2((out[p.mode]||0)+p.amt)});
  return out;
}
/* orders weighed today, so we can compare estimated weight to the actual weighed weight */
function weighedToday(){
  const now=new Date().toISOString();
  return visOrders().filter(o=>o.log.some(l=>l.k==='weighed'&&sameDay(l.at,now)));
}
function wastageStats(){
  const orders=weighedToday();
  let est=0,act=0,n=0;const flags=[];
  orders.forEach(o=>{o.items.forEach((it,i)=>{
    const c=calcItem(it,'est');
    if(c&&Number(it.aw)>0){
      est+=c.est;act+=Number(it.aw);n++;
      const dev=Math.abs(Number(it.aw)-c.est)/c.est*100;
      if(dev>(Number(db.set.warnPct)||5))flags.push({oid:o.id,i,dev:r2(dev),est:c.est,act:Number(it.aw)});
    }
  })});
  const diff=r2(act-est),pct=est>0?r2(diff/est*100):0;
  flags.sort((a,b)=>b.dev-a.dev);
  return {n,est:r2(est),act:r2(act),diff,pct,flags};
}

/* ============ slip numbering ============ */
/* db.next / o.id is the order's PERMANENT internal id — never shown, never resets, used everywhere
   internally for lookups and links. o.slipNo is the label people actually SEE, assigned once when the
   order is created; it can reset daily/monthly/yearly per db.set.numReset so day-to-day numbering feels
   like a fresh book, but a number already given out never changes even if the setting is changed later. */
const MONTH_SHORT=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function slipKeyFor(scheme,iso){
  const d=new Date(iso);
  if(scheme==='daily')return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
  if(scheme==='monthly')return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');
  if(scheme==='yearly'){const y=d.getMonth()>=3?d.getFullYear():d.getFullYear()-1;return y+'-'+(y+1)} // Indian financial year, 1 Apr - 31 Mar
  return 'all';
}
function slipTagFor(scheme,iso){
  const d=new Date(iso),mon=MONTH_SHORT[d.getMonth()];
  if(scheme==='daily')return d.getDate()+mon;
  if(scheme==='monthly')return mon+String(d.getFullYear()).slice(-2);
  if(scheme==='yearly'){const y=d.getMonth()>=3?d.getFullYear():d.getFullYear()-1;return 'FY'+String(y).slice(-2)+'-'+String(y+1).slice(-2)}
  return '';
}
const formatSlipNo=(scheme,iso,n)=>{const tag=slipTagFor(scheme,iso);return tag?`${tag}-${n}`:String(n)};
/* call once, when an order is actually created — consumes the next number and saves it.
   'never' (continuous) just mirrors the order's own permanent internal id, so numbering keeps
   flowing exactly as it always has (no separate counter needed, nothing jumps back to 1). */
function nextSlipNo(contId){
  const scheme=db.set.numReset||'never';
  if(scheme==='never')return String(contId);
  const now=new Date().toISOString(),key=slipKeyFor(scheme,now);
  db.slipCounters=db.slipCounters||{};
  const n=(db.slipCounters[key]||0)+1;db.slipCounters[key]=n;
  return formatSlipNo(scheme,now,n);
}
/* preview only, for "this will be slip #..." before saving — does not consume a number */
function peekSlipNo(){
  const scheme=db.set.numReset||'never';
  if(scheme==='never')return String(db.next);
  const now=new Date().toISOString(),key=slipKeyFor(scheme,now);
  const n=((db.slipCounters||{})[key]||0)+1;
  return formatSlipNo(scheme,now,n);
}
/* the label to show for an order, given just its internal id (for places that only have a payment's oid) */
function slipNoOf(oid){const o=db.orders.find(x=>x.id===oid);return o?(o.slipNo||o.id):oid}

/* ============ seed ============ */
function ago(days,h=11,m=0){const d=new Date();d.setDate(d.getDate()-days);d.setHours(h,m,0,0);return d.toISOString()}
function seedDb(){
  db={v:2,lang:'en',me:'u1',next:1061,npay:1,
    set:{kachaPct:10,gstPct:18,minInch:1,unit:'mm',showWeight:true,warnPct:5,numReset:'never',shop:{name:'SRS Trading',phone:'',gst:''}},
    users:[{id:'u1',name:'Papa',role:'owner',perms:PRESET.owner()},{id:'u2',name:'Parth',role:'owner',perms:PRESET.owner()},{id:'u3',name:'Ramesh',role:'sales',perms:PRESET.sales()},{id:'u4',name:'Suresh',role:'weigher',perms:PRESET.weigher()},{id:'u5',name:'Anil',role:'accounts',perms:PRESET.accounts()}],
    mats:seedMats(),
    cust:[{id:'c1',name:'Sharma Engineering',phone:'98765 04521',special:{}},{id:'c2',name:'Rana Tools',phone:'98111 22334',special:{EN8:72,SS304:228}},{id:'c3',name:'Gupta Fabricators',phone:'98980 11223',special:{}},{id:'c4',name:'Kumar Machines',phone:'97654 32100',special:{}},{id:'c5',name:'Verma Enterprises',phone:'98222 33445',special:{}},{id:'c6',name:'Walk-in customer',phone:'',special:{}}],
    orders:[],pays:[],cashClose:{},slipCounters:{}};
  const it=(mat,shape,d,len,pcs,cust,awf,unit)=>{const m=matById(mat),rr=resolveRate(mat,cust);const x={matId:mat,grade:mat,unit:unit||'mm',shape,d,rows:[{len,pcs,cuts:''}],rate:rr.rate,special:rr.special,cutRate:m.cut,density:densOf(m),aw:null};if(awf){const c=calcItem(x,'est');x.aw=Math.round(c.est*awf*10)/10}return x};
  /* fin = {adv:{amt,mode}, mode:'now'|'later'|'part', pm:'Cash', paid:n} */
  const O=(id,cust,bill,day,h,status,items,fin)=>{
    const at=ago(day,h,5),by=bill==='kacha'?'Ramesh':'Papa';
    const log=[{at,by,k:'created'}];
    if(status!=='estimate')log.push({at:ago(day,h,20),by,k:'accepted'});
    if(status==='weighed'||status==='done')log.push({at:ago(day,h+1,10),by:'Suresh',k:'weighed'});
    const o={id,cust,bill:null,at,status,kachaPct:null,gstPct:null,items,pay:null,doneAt:null,inKhata:false,log,slipNo:String(id)};
    db.orders.push(o);
    const f=fin||{};
    if(f.adv)db.pays.push({id:'p'+(db.npay++),cust,at:ago(day,h,25),amt:f.adv.amt,mode:f.adv.mode,side:null,oid:id,kind:'advance'});
    if(status==='done'){
      o.bill=bill;o.kachaPct=10;o.gstPct=18;o.doneAt=ago(day,h+2,0);o.pay={mode:f.mode};
      const T=orderTotals(o,'final').total,A=f.adv?f.adv.amt:0,B=Math.max(0,r2(T-A));
      db.pays.filter(p=>p.oid===id).forEach(p=>p.side=bill);
      let now=0;if(f.mode==='now')now=B;else if(f.mode==='part')now=f.paid;
      if(now>0)db.pays.push({id:'p'+(db.npay++),cust,at:o.doneAt,amt:now,mode:f.pm||'Cash',side:bill,oid:id,kind:'pay'});
      o.inKhata=r2(A+now)!==T;
      log.push({at:o.doneAt,by:'Papa',k:'done'});
    }
  };
  O(1041,'c1','pakka',7,10,'done',[it('EN8','square',[100],500,5,'c1',1.005),it('EN24','square',[50],300,4,'c1',1.01)],{adv:{amt:10000,mode:'Cash'},mode:'later'});
  O(1044,'c2','pakka',45,10,'done',[it('SS304','plate',[300,400,20],0,10,'c2',1.0)],{adv:{amt:10000,mode:'UPI'},mode:'later'});
  O(1050,'c3','kacha',12,12,'done',[it('MS','flat',[50,10],1000,20,'c3',1.02)],{mode:'later'});
  O(1052,'c1','kacha',4,15,'done',[it('EN24','round',[80],450,6,'c1',1.006)],{mode:'later'});
  O(1054,'c4','pakka',3,10,'done',[it('EN19','round',[40],600,8,'c4',1.004)],{mode:'part',paid:2000,pm:'Cash'});
  O(1056,'c5','pakka',1,16,'estimate',[it('SS316','plate',[200,200,10],0,4,'c5')],null);
  O(1057,'c6','pakka',0,9,'done',[it('MS','flat',[40,6],1000,10,'c6',1.01)],{mode:'now',pm:'Cash'});
  O(1058,'c4','kacha',0,9,'done',[it('EN8','round',[32],300,12,'c4',1.008)],{mode:'now',pm:'UPI'});
  O(1060,'c2',null,0,10,'weighed',[it('EN8','round',[2],10,8,'c2',1.007,'in')],null);
  O(1059,'c3',null,0,11,'accepted',[it('EN9','square',[60],400,6,'c3')],{adv:{amt:5000,mode:'UPI'}});
  db.pays.push({id:'p'+(db.npay++),cust:'c5',at:ago(10,12,0),amt:20000,mode:'Cash',side:'pakka',oid:null,kind:'due'},{id:'p'+(db.npay++),cust:'c3',at:ago(6,13,0),amt:3000,mode:'Cash',side:'kacha',oid:null,kind:'due'});
}
/* old saved orders have items with a single len/pcs/cuts on the item itself;
   bring them into the new rows:[{len,pcs,cuts}] shape so every item is rows-based */
function migrateItems(db){
  (db.orders||[]).forEach(o=>{
    (o.items||[]).forEach(it=>{
      if(!it.rows||!it.rows.length){
        it.rows=[{len:it.len,pcs:it.pcs,cuts:it.cuts||''}];
      }
      delete it.len;delete it.pcs;delete it.cuts;
    });
  });
}
function load(){
  try{const raw=localStorage.getItem(KEY);if(raw){const x=JSON.parse(raw);if(x&&x.v===2&&x.orders){db=x;if(db.fam)Object.keys(db.fam).forEach(k=>{if(FAMILIES[k])FAMILIES[k].d=db.fam[k]});if(!db.cashClose)db.cashClose={};
    /* the customer slip now shows the checked weight by default; turn it on once for anyone with older saved data, but leave it alone after that so a manual toggle sticks */
    if(!db.set.wDefaulted){db.set.showWeight=true;db.set.wDefaulted=true}
    if(!db.set.numReset)db.set.numReset='never';
    if(!db.slipCounters)db.slipCounters={};
    /* older saved orders were only ever shown by their internal id — give them that exact same number as their slipNo, so nothing already sent to a customer changes */
    (db.orders||[]).forEach(o=>{if(!o.slipNo)o.slipNo=String(o.id)});
    migrateItems(db);return}}}catch(e){}
  seedDb();
}
