// Placeholder for screens still being built in Milestone 5.
import { t } from '../lib/i18n.js';
import { Icon, TopBar } from '../ui/kit.jsx';

export function Soon({ word }) {
  return (
    <>
      <TopBar title={t(word)} />
      <div class="page">
        <div class="card pad" style="text-align:center;padding:40px 20px">
          <div class="iconbox tone-accent" style="margin:0 auto 14px;width:56px;height:56px;border-radius:18px"><Icon name="Sparkles" size={26} /></div>
          <div style="font-weight:800;font-size:18px">{t('soon')}</div>
          <div class="muted" style="margin-top:6px">{t('soon_s')}</div>
        </div>
      </div>
    </>
  );
}
