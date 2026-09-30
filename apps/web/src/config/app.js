// ─────────────────────────────────────────────────────────────────────────────
// APP-WIDE SETTINGS — change the product name, languages or brand here only.
// (Shop-specific things like GST % live in the database settings, not here.)
// ─────────────────────────────────────────────────────────────────────────────
export const APP = {
  name: 'SRS Trading',          // product name is still open — rename here (and in index.html + public/manifest.webmanifest)
  version: '0.6.0',
  apiVersion: 1,                // must match the backend "api" function
  languages: [                  // order = order in the language switch
    { id: 'en', label: 'English' },
    { id: 'hi', label: 'हिंदी' },
    { id: 'hn', label: 'Hinglish' },
  ],
  defaultLanguage: 'en',
  moneyLocale: 'en-IN',
  laptopWidth: 1024,            // wider than this → laptop layout (menu on the left)
  countryCode: '+91',
};

export const BACKEND = {
  url: import.meta.env.VITE_SUPABASE_URL,
  publicKey: import.meta.env.VITE_SUPABASE_PUBLIC_KEY, // public by design (it is in every copy of the app)
};
