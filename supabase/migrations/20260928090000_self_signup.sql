-- =====================================================================================
-- 11. The "front door": a business can register itself, staff join from an invite.
--
--  • Anyone can prove a mobile number with an SMS code (sign-up is now on in Supabase Auth),
--    but a number that is not in a shop still sees NOTHING — every read needs an unlocked
--    staff session, exactly as before.
--  • register_company(): a proven number with no shop creates its business in one step:
--    company + settings + the owner + team members (by mobile number) + the trade's starting
--    grades and rates + the owner's PIN. It needs an SMS code from the last 30 minutes.
--  • join_by_phone(): after an SMS code, a number the owner added (and who has no login yet)
--    is linked to that staff record — that is how a WhatsApp invite works.
--  • Every new business starts a 30-day free trial. Plans and payments come later.
-- =====================================================================================

alter table public.companies
  add column trade          text not null default 'steel' check (trade in ('steel','pipes','nonferrous','hardware','plywood','tiles','cables','other')),
  add column city           text check (city is null or length(city) <= 100),
  add column state          text check (state is null or length(state) <= 100),
  add column plan           text not null default 'trial' check (plan in ('trial','starter','business','multi')),
  add column chosen_plan    text check (chosen_plan is null or chosen_plan in ('starter','business','multi')),
  add column trial_ends_at  timestamptz,
  add column created_by_user uuid references auth.users(id) on delete set null;
comment on column public.companies.trade is 'What the business sells; picks the starting grades, units and slip layout.';
comment on column public.companies.trial_ends_at is 'End of the free trial (null = no limit, e.g. companies set up by hand).';

alter table public.company_settings
  add column estimates_enabled boolean not null default true;
comment on column public.company_settings.estimates_enabled is 'Does this business also make bills without GST (estimates)? If off, the app hides that choice.';

-- Starting grades and rates for each trade (the rates are only a starting point; the owner checks them).
create function app.trade_template(p_trade text) returns jsonb
language sql immutable set search_path = '' as $$
  select case p_trade
    when 'steel' then $tpl$[{"code":"MS","family":"carbon","density":null,"sell":58,"cut":2,"info":{"eq":"IS 2062 / A36 type","what":["Low-carbon steel. Soft, easy to cut, bend and weld. It does not get much harder with heat treatment.","कम कार्बन वाला स्टील। नरम है, काटना, मोड़ना और वेल्ड करना आसान। हीट ट्रीटमेंट से ज़्यादा सख़्त नहीं होता।","Kam carbon wala steel. Naram hai, kaatna, modna aur weld karna aasaan. Heat treatment se zyada sakht nahi hota."],"good":[["Frames and brackets","Base plates","General fabrication","Structures"],["फ्रेम और ब्रैकेट","बेस प्लेट","आम फैब्रिकेशन","ढांचे"],["Frame aur bracket","Base plate","Aam fabrication","Dhaancha"]],"watch":["Rusts if left unprotected. Not for shafts that carry heavy load.","सुरक्षा न हो तो ज़ंग लगता है। भारी लोड वाले शाफ्ट के लिए नहीं।","Suraksha na ho to zang lagta hai. Bhaari load wale shaft ke liye nahi."],"alts":[["EN8",["Stronger. Use when the part carries load.","ज़्यादा मज़बूत। लोड वाले पार्ट के लिए।","Zyada mazboot. Load wale part ke liye."]]]}},{"code":"EN8","family":"carbon","density":null,"sell":75,"cut":3,"info":{"eq":"≈ C45 / 1045 / 080M40","what":["Medium-carbon steel (about 0.4% carbon). Good strength, machines well, and the surface can be hardened. The most common all-round shaft steel.","मध्यम कार्बन स्टील (लगभग 0.4% कार्बन)। अच्छी मज़बूती, आसानी से मशीन होता है, ऊपरी सतह सख़्त की जा सकती है। शाफ्ट के लिए सबसे आम स्टील।","Madhyam carbon steel (lagbhag 0.4% carbon). Achhi mazbooti, aasaani se machine hota hai, upar ki satah sakht ho sakti hai. Shaft ke liye sabse aam steel."],"good":[["Shafts and axles","Bolts and studs","Pins and keys","Light-duty gears"],["शाफ्ट और एक्सल","बोल्ट और स्टड","पिन और की","हल्के गियर"],["Shaft aur axle","Bolt aur stud","Pin aur key","Halke gear"]],"watch":["Not for very heavy or shock loads. Go to EN19 or EN24 for those.","बहुत भारी या झटके वाले लोड के लिए नहीं। उसके लिए EN19 या EN24 लें।","Bahut bhaari ya jhatke wale load ke liye nahi. Uske liye EN19 ya EN24 lo."],"alts":[["EN9",["A bit harder and stronger (more carbon).","थोड़ा ज़्यादा सख़्त और मज़बूत (ज़्यादा कार्बन)।","Thoda zyada sakht aur mazboot (zyada carbon)."]],["EN19",["Much stronger alloy steel. Costs more.","बहुत मज़बूत अलॉय स्टील। दाम ज़्यादा।","Bahut mazboot alloy steel. Daam zyada."]]]}},{"code":"EN9","family":"carbon","density":null,"sell":78,"cut":3,"info":{"eq":"≈ 070M55 / C55","what":["Higher-carbon steel (about 0.5 to 0.6% carbon). Harder and more wear-resistant than EN8, a little harder to machine.","ज़्यादा कार्बन वाला स्टील (लगभग 0.5 से 0.6%)। EN8 से सख़्त और घिसाव सहने वाला, मशीन करना थोड़ा मुश्किल।","Zyada carbon wala steel (lagbhag 0.5 se 0.6%). EN8 se sakht aur ghisaav sehne wala, machine karna thoda mushkil."],"good":[["Gears and sprockets","Shafts with more wear","Cams","Rollers"],["गियर और स्प्रोकेट","ज़्यादा घिसने वाले शाफ्ट","कैम","रोलर"],["Gear aur sprocket","Zyada ghisne wale shaft","Cam","Roller"]],"watch":["Can crack if heated and cooled badly. Weld only with care.","गलत तरीके से गरम-ठंडा करने पर फट सकता है। वेल्डिंग सावधानी से।","Galat tareeke se garam-thanda karne par phat sakta hai. Welding savdhani se."],"alts":[["EN8",["Easier to machine and cheaper.","मशीन करना आसान और सस्ता।","Machine karna aasaan aur sasta."]],["EN19",["Stronger and tougher alloy steel.","ज़्यादा मज़बूत और टिकाऊ अलॉय स्टील।","Zyada mazboot aur tikaau alloy steel."]]]}},{"code":"EN19","family":"alloy","density":null,"sell":92,"cut":4,"info":{"eq":"≈ 4140 / 42CrMo4 / 605M36","what":["Chromium-molybdenum alloy steel. High strength, good toughness and long fatigue life. Often supplied hardened and tempered.","क्रोम-मोली अलॉय स्टील। ज़्यादा मज़बूती, अच्छी टिकाऊपन और थकान सहने की क्षमता। अक्सर हार्डन और टेम्पर करके मिलता है।","Chrome-moly alloy steel. Zyada mazbooti, achha tikaaupan aur thakaan sehne ki kshamta. Aksar harden aur temper karke milta hai."],"good":[["High-strength shafts","Spindles","Studs and bolts","Gears","Hydraulic parts"],["ज़्यादा मज़बूत शाफ्ट","स्पिंडल","स्टड और बोल्ट","गियर","हाइड्रोलिक पार्ट"],["Zyada mazboot shaft","Spindle","Stud aur bolt","Gear","Hydraulic part"]],"watch":["Harder to machine than EN8. Pre-heat before welding.","EN8 से मशीन करना मुश्किल। वेल्डिंग से पहले गरम करें।","EN8 se machine karna mushkil. Welding se pehle garam karo."],"alts":[["EN24",["Stronger, hardens deeper. Costs more.","ज़्यादा मज़बूत, गहराई तक सख़्त। दाम ज़्यादा।","Zyada mazboot, gehraai tak sakht. Daam zyada."]],["EN8",["Fine if the strength needed is lower. Cheaper.","कम मज़बूती चाहिए तो ठीक। सस्ता।","Kam mazbooti chahiye to theek. Sasta."]]]}},{"code":"EN24","family":"alloy","density":null,"sell":95,"cut":4,"info":{"eq":"≈ 4340 / 817M40","what":["Nickel-chromium-molybdenum alloy steel. Very high strength and toughness, and it hardens deep even in thick sections.","निकल-क्रोम-मोली अलॉय स्टील। बहुत ज़्यादा मज़बूती और टिकाऊपन, मोटे साइज़ में भी गहराई तक सख़्त होता है।","Nickel-chrome-moly alloy steel. Bahut zyada mazbooti aur tikaaupan, mote size mein bhi gehraai tak sakht hota hai."],"good":[["Heavy-duty shafts","Crankshafts","Connecting rods","Large gears","High-stress parts"],["भारी शाफ्ट","क्रैंकशाफ्ट","कनेक्टिंग रॉड","बड़े गियर","ज़्यादा दबाव वाले पार्ट"],["Bhaari shaft","Crankshaft","Connecting rod","Bade gear","Zyada dabaav wale part"]],"watch":["Costs more than EN19. It needs proper heat treatment to give its full strength.","EN19 से महंगा। पूरी मज़बूती के लिए सही हीट ट्रीटमेंट चाहिए।","EN19 se mehnga. Poori mazbooti ke liye sahi heat treatment chahiye."],"alts":[["EN19",["One step lower in strength, but cheaper.","मज़बूती थोड़ी कम, पर सस्ता।","Mazbooti thodi kam, par sasta."]]]}},{"code":"EN31","family":"alloy","density":null,"sell":110,"cut":4,"info":{"eq":"≈ 52100 / 100Cr6","what":["High-carbon chromium steel. Becomes very hard and wear-resistant after hardening.","ज़्यादा कार्बन वाला क्रोम स्टील। हार्डन करने के बाद बहुत सख़्त और घिसाव सहने वाला।","Zyada carbon wala chrome steel. Harden karne ke baad bahut sakht aur ghisaav sehne wala."],"good":[["Bearings and rollers","Bushes","Wear parts","Light-duty punches and dies"],["बेयरिंग और रोलर","बुश","घिसने वाले पार्ट","हल्के पंच और डाई"],["Bearing aur roller","Bush","Ghisne wale part","Halke punch aur die"]],"watch":["Becomes brittle if hardened too much. Not for welding.","ज़्यादा सख़्त करने पर टूटने वाला हो जाता है। वेल्डिंग के लिए नहीं।","Zyada sakht karne par tootne wala ho jaata hai. Welding ke liye nahi."],"alts":[["D2",["Even more wear-resistant, for tools. Costs more.","और ज़्यादा घिसाव सहने वाला, टूल के लिए। महंगा।","Aur zyada ghisaav sehne wala, tool ke liye. Mehnga."]],["EN24",["Tougher, but not as wear-resistant.","ज़्यादा टिकाऊ, पर घिसाव कम सहता है।","Zyada tikaau, par ghisaav kam sehta hai."]]]}},{"code":"EN36","family":"alloy","density":null,"sell":120,"cut":4,"info":{"eq":"≈ 655M13 / 15NiCr13","what":["Case-hardening steel. Tough soft core with a very hard surface after carburising.","केस-हार्डनिंग स्टील। अंदर से नरम और मज़बूत, कार्बराइज़ करने के बाद ऊपर से बहुत सख़्त।","Case-hardening steel. Andar se naram aur mazboot, carburise karne ke baad upar se bahut sakht."],"good":[["Gears and pinions","Camshafts","Shafts that need a hard surface"],["गियर और पिनियन","कैमशाफ्ट","सख़्त सतह वाले शाफ्ट"],["Gear aur pinion","Camshaft","Sakht satah wale shaft"]],"watch":["Meant for case-hardening jobs. If the drawing says through-hardened, use EN19 or EN24 instead.","केस-हार्डनिंग वाले काम के लिए। ड्रॉइंग में थ्रू-हार्डन लिखा हो तो EN19 या EN24 लें।","Case-hardening wale kaam ke liye. Drawing mein through-harden likha ho to EN19 ya EN24 lo."],"alts":[]}},{"code":"D2","family":"tool","density":null,"sell":260,"cut":6,"info":{"eq":"≈ 1.2379 / HCHCr","what":["High-carbon, high-chromium tool steel. Very high wear resistance and holds a sharp edge.","ज़्यादा कार्बन, ज़्यादा क्रोम वाला टूल स्टील। बहुत घिसाव सहता है और धार टिकाए रखता है।","Zyada carbon, zyada chrome wala tool steel. Bahut ghisaav sehta hai aur dhaar tikaaye rakhta hai."],"good":[["Dies and punches","Shear blades","Cutting and forming tools"],["डाई और पंच","शियर ब्लेड","कटिंग और फॉर्मिंग टूल"],["Die aur punch","Shear blade","Cutting aur forming tool"]],"watch":["Costly and hard to machine. Not for parts that face heavy shock.","महंगा और मशीन करना मुश्किल। भारी झटके वाले पार्ट के लिए नहीं।","Mehnga aur machine karna mushkil. Bhaari jhatke wale part ke liye nahi."],"alts":[["EN31",["Cheaper, but wears faster.","सस्ता, पर जल्दी घिसता है।","Sasta, par jaldi ghista hai."]]]}},{"code":"SS304","family":"stainless","density":null,"sell":235,"cut":6,"info":{"eq":"≈ 1.4301 / 18-8","what":["The common stainless steel (about 18% chromium, 8% nickel). Resists rust, easy to clean and weld. It cannot be hardened by heat treatment.","आम स्टेनलेस स्टील (लगभग 18% क्रोम, 8% निकल)। ज़ंग नहीं लगता, साफ़ करना और वेल्ड करना आसान। हीट ट्रीटमेंट से सख़्त नहीं होता।","Aam stainless steel (lagbhag 18% chrome, 8% nickel). Zang nahi lagta, saaf karna aur weld karna aasaan. Heat treatment se sakht nahi hota."],"good":[["Food and dairy equipment","Kitchen ware","Tanks","Railings","General stainless work"],["फ़ूड और डेयरी उपकरण","किचन का सामान","टंकी","रेलिंग","आम स्टेनलेस काम"],["Food aur dairy equipment","Kitchen ka saamaan","Tanki","Railing","Aam stainless kaam"]],"watch":["Not for strong salt or chemical exposure (use SS316). It hardens while cutting, so use a sharp blade and steady feed.","ज़्यादा नमक या केमिकल वाली जगह के लिए नहीं (SS316 लें)। कटते समय सख़्त होता है, इसलिए तेज़ ब्लेड और एक जैसी रफ़्तार रखें।","Zyada namak ya chemical wali jagah ke liye nahi (SS316 lo). Katte samay sakht hota hai, isliye tez blade aur ek jaisi raftaar rakho."],"alts":[["SS316",["Better against salt and chemicals. Costs more.","नमक और केमिकल के लिए बेहतर। महंगा।","Namak aur chemical ke liye behtar. Mehnga."]]]}},{"code":"SS316","family":"stainless","density":7980,"sell":340,"cut":7,"info":{"eq":"≈ 1.4401 / 316","what":["Stainless steel with molybdenum added. Much better than SS304 against salt water and chemicals.","मोलिब्डेनम मिला स्टेनलेस स्टील। नमकीन पानी और केमिकल में SS304 से काफ़ी बेहतर।","Molybdenum mila stainless steel. Namkeen paani aur chemical mein SS304 se kaafi behtar."],"good":[["Marine fittings","Chemical and pharma equipment","Coastal outdoor use"],["समुद्री फिटिंग","केमिकल और फार्मा उपकरण","समुद्र किनारे बाहर का काम"],["Samudri fitting","Chemical aur pharma equipment","Samudra kinare bahar ka kaam"]],"watch":["Costs more than SS304. Same care while cutting.","SS304 से महंगा। कटिंग में वही सावधानी।","SS304 se mehnga. Cutting mein wahi savdhani."],"alts":[["SS304",["Fine for mild conditions. Cheaper.","हल्की स्थिति में ठीक। सस्ता।","Halki sthiti mein theek. Sasta."]]]}}]$tpl$::jsonb
    else '[]'::jsonb end
$$;

-- ---------- where am I in the login steps? (now also tells the trial and bill settings) ----------
create or replace function public.login_status(p_company uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  p public.people; c public.companies; s public.company_settings; cred private.auth_credentials; unlocked uuid;
begin
  if (select auth.uid()) is null then return jsonb_build_object('signed_in', false); end if;
  p := app.login_person(p_company);
  if p.id is null then
    return jsonb_build_object('signed_in', true, 'staff', false, 'can_register', app.recent_otp(30),
      'phone', (select '+' || u.phone from auth.users u where u.id = (select auth.uid()) and u.phone is not null));
  end if;
  select * into c from public.companies where id = p.company_id;
  select * into s from public.company_settings where company_id = p.company_id;
  select * into cred from private.auth_credentials where person_id = p.id and kind = 'pin' and revoked_at is null;
  unlocked := app.current_person_id();
  return jsonb_build_object(
    'signed_in', true, 'staff', true,
    'unlocked', unlocked is not null,
    'has_pin', cred.id is not null,
    'blocked', coalesce(cred.failed_attempts, 0) >= 10,
    'locked_until', case when cred.locked_until > now() then cred.locked_until end,
    'pin_length', app.pin_length_for(p),
    'can_set_pin', app.recent_otp(),
    'person', jsonb_build_object('id', p.id, 'name', p.display_name, 'role', p.role, 'perms', p.perms, 'lang', p.preferred_lang),
    'company', jsonb_build_object('id', c.id, 'name', c.name, 'timezone', c.timezone, 'trade', c.trade, 'city', c.city,
      'plan', c.plan, 'trial_ends_at', c.trial_ends_at, 'estimates', coalesce(s.estimates_enabled, true)));
end $$;

-- ---------- a new business registers itself ----------
-- p: { name, legal_name, gstin, city, state, trade, owner_name, lang, first_slip_no, estimates,
--      plan, team: [{ name, phone, role }] }   and the owner's new PIN.
create function public.register_company(p jsonb, p_pin text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  sid uuid := nullif((select auth.jwt()) ->> 'session_id', '')::uuid;
  v_owner_phone text; v_owner public.people; v_draft public.people; v_problem text; cid uuid;
  v_name text := btrim(coalesce(p ->> 'name', ''));
  v_owner_name text := btrim(coalesce(p ->> 'owner_name', ''));
  v_trade text := coalesce(nullif(p ->> 'trade', ''), 'steel');
  v_lang text := coalesce(nullif(p ->> 'lang', ''), 'en');
  v_gst text := nullif(upper(regexp_replace(coalesce(p ->> 'gstin', ''), '\s', '', 'g')), '');
  v_first_no bigint := coalesce(nullif(p ->> 'first_slip_no', '')::bigint, 1);
  v_plan text := nullif(p ->> 'plan', '');
  v_team jsonb := coalesce(p -> 'team', '[]'::jsonb);
  m jsonb; t jsonb; mid uuid; v_hours integer;
begin
  if uid is null or sid is null then raise exception 'Not signed in.' using errcode = '42501'; end if;
  -- Already in a shop (e.g. the button was pressed twice): nothing new, just say where we are.
  if (app.login_person(null)).id is not null then return public.login_status(); end if;
  if not app.recent_otp(30) then
    raise exception 'For safety, confirm your mobile number with a new SMS code first.' using errcode = '42501';
  end if;

  select '+' || u.phone into v_owner_phone from auth.users u where u.id = uid and u.phone is not null and u.phone_confirmed_at is not null;
  if length(v_name) not between 1 and 200 then raise exception 'Enter the shop name.' using errcode = '22023'; end if;
  if length(v_owner_name) not between 1 and 100 then raise exception 'Enter your name.' using errcode = '22023'; end if;
  if v_trade <> 'steel' then raise exception 'Only steel & metals can be set up for now.' using errcode = '22023'; end if;
  if v_lang not in ('en','hi','hn') then v_lang := 'en'; end if;
  if v_gst is not null and v_gst !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' then
    raise exception 'That GST number does not look right.' using errcode = '22023';
  end if;
  if v_first_no not between 1 and 999999999 then raise exception 'The first slip number must be between 1 and 999999999.' using errcode = '22023'; end if;
  if v_plan is not null and v_plan not in ('starter','business','multi') then v_plan := null; end if;
  if jsonb_typeof(v_team) <> 'array' or jsonb_array_length(v_team) > 25 then raise exception 'Too many people at once (25 at most).' using errcode = '22023'; end if;

  v_draft.perms := app.role_preset('owner'); v_draft.phone := v_owner_phone;
  v_problem := app.pin_problem(p_pin, v_draft);
  if v_problem is not null then raise exception '%', v_problem using errcode = '22023'; end if;

  insert into public.companies (name, legal_name, gstin, phone, city, state, trade, plan, chosen_plan, trial_ends_at, created_by_user)
    values (v_name, nullif(btrim(coalesce(p ->> 'legal_name', '')), ''), v_gst, v_owner_phone,
            nullif(btrim(coalesce(p ->> 'city', '')), ''), nullif(btrim(coalesce(p ->> 'state', '')), ''),
            v_trade, 'trial', v_plan, now() + interval '30 days', uid)
    returning id into cid;

  insert into public.people (company_id, auth_user_id, display_name, phone, role, perms, preferred_lang)
    values (cid, uid, v_owner_name, v_owner_phone, 'owner', app.role_preset('owner'), v_lang)
    returning * into v_owner;
  perform set_config('app.person_id', v_owner.id::text, true);

  insert into public.company_settings (company_id, first_slip_no, estimates_enabled, updated_by)
    values (cid, v_first_no, coalesce((p ->> 'estimates')::boolean, true), v_owner.id);

  -- Team members: added by mobile number; they join when they log in with an SMS code.
  for t in select * from jsonb_array_elements(v_team) loop
    if coalesce(t ->> 'phone', '') !~ '^\+91[6-9][0-9]{9}$' then raise exception 'A team member''s mobile number is not right.' using errcode = '22023'; end if;
    if coalesce(t ->> 'role', '') not in ('owner','sales','weigher','accounts') then raise exception 'Unknown role.' using errcode = '22023'; end if;
    if length(btrim(coalesce(t ->> 'name', ''))) not between 1 and 100 then raise exception 'Enter each person''s name.' using errcode = '22023'; end if;
    insert into public.people (company_id, display_name, phone, role, perms, preferred_lang)
      select cid, btrim(t ->> 'name'), t ->> 'phone', t ->> 'role', app.role_preset(t ->> 'role'), 'en'
      where (t ->> 'phone') is distinct from v_owner_phone
      on conflict (company_id, phone) do nothing;
  end loop;

  -- Starting grades and rates for the trade.
  for m in select * from jsonb_array_elements(app.trade_template(v_trade)) loop
    insert into public.materials (company_id, code, family, density_override, info)
      values (cid, m ->> 'code', m ->> 'family', nullif(m ->> 'density', '')::numeric, case when jsonb_typeof(m -> 'info') = 'object' then m -> 'info' end)
      returning id into mid;
    insert into public.material_rates (company_id, material_id, sell_rate, cut_rate, note, created_by)
      values (cid, mid, (m ->> 'sell')::numeric, (m ->> 'cut')::numeric, 'starting rate — please check', v_owner.id);
  end loop;

  -- The owner's PIN, and this phone is unlocked straight away.
  insert into private.auth_credentials (company_id, person_id, kind, secret_hash)
    values (cid, v_owner.id, 'pin', extensions.crypt(p_pin, extensions.gen_salt('bf', 10)));
  select unlock_hours into v_hours from public.company_settings where company_id = cid;
  insert into private.session_unlocks (session_id, company_id, person_id, expires_at)
    values (sid, cid, v_owner.id, now() + make_interval(hours => coalesce(v_hours, 12)))
    on conflict (session_id) do update set company_id = excluded.company_id, person_id = excluded.person_id,
      unlocked_at = now(), expires_at = excluded.expires_at;
  return public.login_status(cid);
end $$;

-- ---------- an invited person logs in for the first time ----------
-- Links staff records that carry this (SMS-proven) mobile number and have no login yet.
create function public.join_by_phone() returns integer
language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid()); ph text; n integer;
begin
  if uid is null then raise exception 'Not signed in.' using errcode = '42501'; end if;
  if not app.recent_otp(10) then return 0; end if;
  select '+' || u.phone into ph from auth.users u where u.id = uid and u.phone is not null and u.phone_confirmed_at is not null;
  if ph is null then return 0; end if;
  update public.people p set auth_user_id = uid
    where p.phone = ph and p.auth_user_id is null and p.active
      and not exists (select 1 from public.people q where q.company_id = p.company_id and q.auth_user_id = uid);
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.register_company(jsonb, text), public.join_by_phone() from public, anon;
revoke all on function app.trade_template(text) from public, anon, authenticated;
grant execute on function public.register_company(jsonb, text), public.join_by_phone() to authenticated;
grant execute on function app.trade_template(text) to service_role;
