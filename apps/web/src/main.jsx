import { render } from 'preact';
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';
import '@fontsource/inter/latin-800.css';
import '@fontsource/noto-sans-devanagari/devanagari-400.css';
import '@fontsource/noto-sans-devanagari/devanagari-600.css';
import '@fontsource/noto-sans-devanagari/devanagari-700.css';
import './theme/tokens.css';
import './theme/ui.css';
import './theme/layout.css';
import { applyTheme } from './lib/theme.js';
import { setLang, lang } from './lib/i18n.js';
import { App } from './app.jsx';
import { watchUpdates } from './lib/update.js';

applyTheme();
setLang(lang.value);
render(<App />, document.getElementById('app'));
watchUpdates();

// Installed app ("Add to Home Screen"): lets it open even on a weak network. Only on the real https site.
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('./sw.js').catch(() => {});
