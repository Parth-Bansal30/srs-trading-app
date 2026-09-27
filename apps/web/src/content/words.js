// ─────────────────────────────────────────────────────────────────────────────
// ALL WORDS THE APP SHOWS — one place, three languages: [English, Hindi, Hinglish].
//
// To change a word: find its key below (or in words-prototype.js) and edit the text.
// A key here OVERRIDES the same key from the prototype list, so you can rename things
// (e.g. "Khata" → "Udhaar") without touching any screen.
// {0}, {1}… are filled in by the app (numbers, names).
// ─────────────────────────────────────────────────────────────────────────────
import { PROTOTYPE_WORDS } from './words-prototype.js';

const NEW_WORDS = {
  // ---------- navigation ----------
  nav_today: ['Today', 'आज', 'Aaj'],
  nav_slips: ['Slips', 'पर्चियां', 'Parchiyan'],
  nav_khata: ['Khata', 'खाता', 'Khata'],
  nav_more: ['More', 'और', 'Aur'],
  nav_new: ['New order', 'नया ऑर्डर', 'Naya order'],
  nav_weigh: ['Weighing', 'तौल', 'Tol'],
  nav_reminders: ['Reminders', 'याद दिलाना', 'Yaad dilana'],
  nav_rates: ['Rates', 'रेट', 'Rate'],
  nav_people: ['People', 'लोग', 'Log'],
  nav_settings: ['Settings', 'सेटिंग्स', 'Settings'],
  nav_reports: ['Reports', 'रिपोर्ट', 'Report'],
  nav_guide: ['Steel guide', 'स्टील गाइड', 'Steel guide'],
  back: ['Back', 'वापस', 'Wapas'],
  soon: ['Coming soon', 'जल्द आ रहा है', 'Jaldi aa raha hai'],
  soon_s: ['This screen is being built.', 'यह स्क्रीन बन रही है।', 'Yeh screen ban rahi hai.'],

  // ---------- login ----------
  login_title: ['Log in', 'लॉग इन', 'Log in'],
  login_phone: ['Your mobile number', 'आपका मोबाइल नंबर', 'Aapka mobile number'],
  login_phone_s: ['We will send a 6-digit code by SMS.', 'हम SMS से 6 अंकों का कोड भेजेंगे।', 'Hum SMS se 6 ank ka code bhejenge.'],
  login_send: ['Send code', 'कोड भेजें', 'Code bhejo'],
  login_bad_phone: ['Enter a 10-digit mobile number.', '10 अंकों का मोबाइल नंबर लिखें।', '10 ank ka mobile number likho.'],
  login_not_added: ['This number is not added. Ask the owner to add you.', 'यह नंबर जोड़ा नहीं गया है। मालिक से जुड़वाएं।', 'Yeh number joda nahi gaya. Malik se judwao.'],
  login_code: ['Enter the code', 'कोड लिखें', 'Code likho'],
  login_code_s: ['Sent to {0}', '{0} पर भेजा गया', '{0} par bheja gaya'],
  login_verify: ['Confirm', 'पक्का करें', 'Confirm karo'],
  login_bad_code: ['That code is wrong or expired.', 'कोड गलत है या पुराना हो गया।', 'Code galat hai ya purana ho gaya.'],
  login_resend: ['Send code again', 'कोड फिर भेजें', 'Code phir bhejo'],
  login_resend_in: ['Send again in {0}s', '{0} सेकंड में फिर भेजें', '{0} sec mein phir bhejo'],
  login_change_no: ['Change number', 'नंबर बदलें', 'Number badlo'],
  login_wait: ['Please wait a minute before asking for another code.', 'नया कोड मांगने से पहले एक मिनट रुकें।', 'Naya code maangne se pehle ek minute ruko.'],
  pin_set_title: ['Set your PIN', 'अपना PIN बनाएं', 'Apna PIN banao'],
  pin_set_s: ['{0} numbers. You will use it every day instead of an SMS.', '{0} अंक। रोज़ SMS की जगह यही लगेगा।', '{0} ank. Roz SMS ki jagah yahi lagega.'],
  pin_again: ['Enter the same PIN again', 'वही PIN फिर लिखें', 'Wahi PIN phir likho'],
  pin_mismatch: ['The two PINs are different. Try again.', 'दोनों PIN अलग हैं। फिर से करें।', 'Dono PIN alag hain. Phir se karo.'],
  pin_enter: ['Enter your PIN', 'अपना PIN लिखें', 'Apna PIN likho'],
  pin_hello: ['Namaste, {0}', 'नमस्ते, {0}', 'Namaste, {0}'],
  pin_wrong: ['Wrong PIN. {0} tries left.', 'गलत PIN। {0} बार और।', 'Galat PIN. {0} baar aur.'],
  pin_locked: ['Too many wrong PINs. Try again after {0}.', 'बहुत बार गलत PIN। {0} के बाद करें।', 'Bahut baar galat PIN. {0} ke baad karo.'],
  pin_blocked: ['PIN blocked. Log in again with an SMS code.', 'PIN बंद हो गया। SMS कोड से फिर लॉग इन करें।', 'PIN band ho gaya. SMS code se phir log in karo.'],
  pin_forgot: ['Forgot PIN?', 'PIN भूल गए?', 'PIN bhool gaye?'],
  not_staff: ['This number is not part of any shop yet.', 'यह नंबर अभी किसी दुकान में नहीं जुड़ा है।', 'Yeh number abhi kisi dukaan mein nahi juda.'],
  lock: ['Lock', 'लॉक करें', 'Lock karo'],
  log_out: ['Log out', 'लॉग आउट', 'Log out'],
  switch_person: ['Switch person', 'व्यक्ति बदलें', 'Vyakti badlo'],

  // ---------- payment methods ----------
  pm_cash: ['Cash', 'कैश', 'Cash'],
  pm_upi: ['UPI', 'UPI', 'UPI'],
  pm_bank: ['Bank', 'बैंक', 'Bank'],
  pm_cheque: ['Cheque', 'चेक', 'Cheque'],

  // ---------- bill types (short, for chips and lists) ----------
  bill_gst_short: ['GST bill', 'GST बिल', 'GST bill'],
  bill_none_short: ['No bill', 'बिना बिल', 'Bina bill'],
  gst_bills: ['GST bills', 'GST बिल', 'GST bill'],
  no_bills: ['No bill', 'बिना बिल', 'Bina bill'],

  // ---------- today ----------
  greet: ['Namaste, {0}', 'नमस्ते, {0}', 'Namaste, {0}'],
  sales_today_cap: ["Today's sales", 'आज की बिक्री', 'Aaj ki bikri'],
  bills_n: ['{0} · {1}', '{0} · {1}', '{0} · {1}'],
  in_drawer: ['In drawer', 'गल्ले में', 'Galle mein'],
  needs_you: ['Needs you now', 'अभी आपका काम', 'Abhi aapka kaam'],
  need_weigh: ['{0} slips waiting to be weighed', '{0} पर्चियां तौल के लिए', '{0} parchiyan tol ke liye'],
  need_weigh_1: ['1 slip waiting to be weighed', '1 पर्ची तौल के लिए', '1 parchi tol ke liye'],
  need_pickup: ['{0} ready for pickup', '{0} ले जाने के लिए तैयार', '{0} le jaane ke liye taiyaar'],
  need_remind: ['{0} payment reminders to approve', '{0} पेमेंट याद दिलाने हैं', '{0} payment yaad dilane hain'],
  need_remind_s: ['{0} pending for {1}+ days', '{0} बाकी, {1}+ दिन से', '{0} baaki, {1}+ din se'],
  need_estimates: ['{0} estimates not accepted yet', '{0} अंदाज़े अभी पक्के नहीं', '{0} andaze abhi pakke nahi'],
  all_done: ['All caught up', 'सब काम हो गया', 'Sab kaam ho gaya'],
  all_done_s: ['Nothing needs you right now.', 'अभी कुछ बाकी नहीं है।', 'Abhi kuch baaki nahi hai.'],
  ask_steel: ['Ask about steel — “grade for a shaft?”', 'स्टील के बारे में पूछें — “शाफ्ट के लिए ग्रेड?”', 'Steel ke baare mein poochho — “shaft ke liye grade?”'],
  see_all: ['See all', 'सब देखें', 'Sab dekho'],
  no_slips_yet: ['No slips yet.', 'अभी कोई पर्ची नहीं।', 'Abhi koi parchi nahi.'],
  n_items: ['{0} items', '{0} आइटम', '{0} item'],
  st_cancelled: ['Cancelled', 'रद्द', 'Radd'],
  loading: ['Loading…', 'लोड हो रहा है…', 'Load ho raha hai…'],
  retry: ['Try again', 'फिर से करें', 'Phir se karo'],
  offline: ['No internet. Showing the last saved view.', 'इंटरनेट नहीं है। पिछली जानकारी दिख रही है।', 'Internet nahi hai. Pichli jaankari dikh rahi hai.'],
  err_generic: ['Something went wrong. Please try again.', 'कुछ गड़बड़ हुई। फिर से करें।', 'Kuch gadbad hui. Phir se karo.'],
  theme: ['Appearance', 'दिखावट', 'Dikhawat'],
  theme_auto: ['Auto', 'अपने-आप', 'Apne-aap'],
  theme_light: ['Light', 'हल्का', 'Halka'],
  theme_dark: ['Dark', 'गहरा', 'Gehra'],
  language_short: ['EN', 'हिं', 'HN'],
};

export const WORDS = { ...PROTOTYPE_WORDS, ...NEW_WORDS };
