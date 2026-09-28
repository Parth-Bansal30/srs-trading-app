// Steel guide: ask a question about grades and uses (answer by Claude through the backend, simple words, no prices).
import { useEffect, useState } from 'preact/hooks';
import { t, lang } from '../lib/i18n.js';
import { useAction } from '../lib/action.js';
import { loadCatalog } from '../lib/catalog.js';
import { go } from '../lib/router.js';
import { Icon, TopBar } from '../ui/kit.jsx';
import { GradeInfo, InfoButton, tri } from '../ui/grades/GradeInfo.jsx';

export function Guide() {
  const [q, setQ] = useState('');
  const [ans, setAns] = useState(null);
  const ask = useAction('askSteelQuestion');
  const go_ = () => q.trim() && ask.run({ question: q, lang: lang.value }).then((r) => setAns(r.answer)).catch(() => setAns(null));
  const err = ask.error;
  const [mats, setMats] = useState([]);
  const [info, setInfo] = useState(null);
  useEffect(() => { loadCatalog().then((c) => setMats(c.materials)).catch(() => {}); }, []);
  return (
    <>
      <TopBar title={t('guide_title')} sub={t('guide_sub')} />
      <div class="page">
        <div class="field" style="background:var(--surface)"><Icon name="Sparkles" size={18} style="color:var(--accent)" />
          <input value={q} onInput={(e) => setQ(e.currentTarget.value)} onKeyDown={(e) => e.key === 'Enter' && go_()} placeholder={t('g_ask_ph')} /></div>
        <button class="btn btn-accent btn-block" style="margin-top:12px" disabled={ask.busy || !q.trim()} onClick={go_}>{ask.busy ? t('g_thinking') : t('g_ask_send')}</button>
        {ans && <div class="card pad" style="margin-top:14px;white-space:pre-wrap;line-height:1.55">{ans}<div class="faint" style="font-size:12px;margin-top:10px">{t('g_ai_note')}</div></div>}
        {err && <div class="notice tone-warn" style="margin-top:14px">{err.code === 'ai_not_configured' ? `${err.message}` : err.code === 'daily_limit' ? t('g_limit') : t('g_error')}</div>}
        <div class="faint" style="font-size:13px;margin-top:14px">{t('g_ask_note')}</div>

        <div class="sec"><h3>{t('gi_all')}</h3><button class="link" onClick={() => go('/compare')}><Icon name="GitCompare" size={15} stroke={2.3} />{t('gi_compare')}</button></div>
        <div class="card">
          {mats.filter((m) => m.active).map((m) => (
            <button class="li" onClick={() => setInfo(m)}>
              <div class="grow"><div class="t">{m.code}</div><div class="s ellip">{tri(m.info?.kind) || t(`fam_${m.family}`)}</div></div>
              <InfoButton onClick={() => setInfo(m)} label={`${m.code} info`} />
            </button>
          ))}
        </div>
      </div>
      <GradeInfo m={info} materials={mats} open={!!info} onClose={() => setInfo(null)} />
    </>
  );
}
