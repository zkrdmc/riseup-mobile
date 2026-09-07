/* ── FILE: src/i18n/dictionaries.ts ────────────────────────────────────── */
/* ─────────────────────────────────────────────────────────────────────────────
   Dictionary.

   Flat, dotted, namespaced keys — the same convention as
   `riseup-website/src/lib/i18n.ts`, and where a string exists on both the site
   and the app the key is the same one (`lang.label`, `lang.en`, `lang.fr`), so
   the two can be reconciled by a script rather than by eye.

   ── WHAT IS TRANSLATED, AND WHAT IS DELIBERATELY LEFT IN ENGLISH ──────────

   Translated: the app's chrome. Navigation, buttons, field labels, sign-in,
   account and settings. Short, non-technical, and a small error costs a moment
   of confusion.

   NOT translated, and falling back to English on purpose: the operator
   guidance in `capture/survey/validate.ts`, `capture/framing/visibility.ts`,
   `capture/framing/pair.ts` and `capture/devices/catalogue.ts`. Those strings
   say why a rig will not record and what to change — "the markings both
   cameras share all lie along one line", "HyperSmooth is the factory default
   and warps every frame". Acting on a mistranslation there costs an
   unrepeatable match.

   The website's own translate script makes this argument for football French
   and it applies with more force to camera geometry: a general translator
   produces "buts attendus" for xG and every sporting director knows a machine
   wrote it. I can write the French for the chrome below. I would be guessing
   at Arabic for pitch and camera vocabulary, and a confident wrong instruction
   is worse than a correct English one — an operator acts on the first and asks
   about the second.

   Those strings want the same treatment the site uses: `npm run translate`
   with a domain glossary, then a human who knows the domain, before release.
   `missingKeys()` in `i18n.ts` reports the gap so it stays visible.

   ── REGISTER ─────────────────────────────────────────────────────────────
   French: vouvoiement, Moroccan professional French, matching the site.
   Arabic: Modern Standard, Western digits (0-9) not Eastern (٠-٩) — Moroccan
   Arabic writing uses Western digits and a distance rendered ٤٫٢ reads as
   foreign to the audience this is for.
   ───────────────────────────────────────────────────────────────────────────── */

import type { Dict } from './i18n';

export const en: Dict = {
  'common.cancel': 'Cancel',
  'common.back': 'Back',
  'common.next': 'Next',
  'common.retry': 'Try again',
  'common.close': 'Close',
  'common.loading': 'Loading',
  'common.signOut': 'Sign out',

  'lang.label': 'Language',
  'lang.en': 'English',
  'lang.fr': 'Français',
  'lang.ar': 'العربية',
  'lang.subtitle': 'Used on your phone and on the dashboard.',
  'lang.restartTitle': 'Restart to change direction',
  'lang.restartBody':
    'Arabic reads right to left, and the app has to restart to lay itself out that way. Nothing you have entered is lost.',
  'lang.restartNow': 'Restart now',
  'lang.notNow': 'Not now',
  'lang.syncFailed':
    'Saved on this phone. It will sync to your account when you are back online.',

  'tabs.matches': 'Matches',
  'tabs.capture': 'Capture',
  'tabs.uploads': 'Uploads',
  'tabs.inbox': 'Inbox',
  'tabs.settings': 'Settings',

  'auth.signIn': 'Sign in',
  'auth.subtitle': 'The same account you use on the dashboard.',
  'auth.email': 'Email',
  'auth.password': 'Password',
  'auth.code': 'Code',
  'auth.continue': 'Continue',
  'auth.codeSentTo': 'We sent a code to {address}.',
  'auth.emailCodeInstead': 'Email me a code instead',
  'auth.sendAgain': 'Send it again',
  'auth.differentEmail': 'Use a different email',
  'auth.noAccount': 'No account?',
  'auth.askAdmin': 'A club admin invites you from the dashboard.',
  'auth.privacy': 'Privacy',
  'auth.terms': 'Terms',
  'auth.support': 'Support',

  'club.notInClubTitle': 'You are not in a club yet',
  'club.notInClubBody':
    'A club admin adds people from the RiseUp dashboard. Once they add you, sign out and back in here and everything will be waiting.',
  'club.whichClub': 'Which club?',
  'club.memberOfSeveral':
    'You are a member of more than one. You can switch later in settings.',
  'club.finding': 'Finding your club',
  'club.checking': 'Checking your club',

  'settings.title': 'Settings',
  'settings.account': 'Account',
  'settings.signedInAs': 'Signed in as',
  'settings.club': 'Club',
  'settings.dashboardRole': 'Dashboard role',
  'settings.thisDevice': 'This device',
  'settings.opensOnMatches': 'Opens on the match list',
  'settings.opensOnCapture': 'Opens on capture',
  'settings.analyst': 'Analyst',
  'settings.operator': 'Operator',
  'settings.help': 'Help',
  'settings.reportProblem': 'Report a problem',
  'settings.somethingBroken': 'Something broken or confusing',
  'settings.privacyPolicy': 'Privacy policy',
  'settings.termsOfService': 'Terms of service',
  'settings.notifications': 'Notifications',
  'settings.deleteAccount': 'Delete account',
  'settings.deleteMyAccount': 'Delete my account',
  'settings.deleting': 'Deleting…',
};

export const fr: Dict = {
  'common.cancel': 'Annuler',
  'common.back': 'Retour',
  'common.next': 'Suivant',
  'common.retry': 'Réessayer',
  'common.close': 'Fermer',
  'common.loading': 'Chargement',
  'common.signOut': 'Se déconnecter',

  'lang.label': 'Langue',
  'lang.en': 'English',
  'lang.fr': 'Français',
  'lang.ar': 'العربية',
  'lang.subtitle': 'Utilisée sur votre téléphone et sur le tableau de bord.',
  'lang.restartTitle': 'Redémarrage nécessaire',
  'lang.restartBody':
    "L'arabe se lit de droite à gauche, et l'application doit redémarrer pour s'afficher ainsi. Rien de ce que vous avez saisi n'est perdu.",
  'lang.restartNow': 'Redémarrer',
  'lang.notNow': 'Plus tard',
  'lang.syncFailed':
    'Enregistré sur ce téléphone. La synchronisation se fera dès que vous serez en ligne.',

  'tabs.matches': 'Matchs',
  'tabs.capture': 'Captation',
  'tabs.uploads': 'Envois',
  'tabs.inbox': 'Messages',
  'tabs.settings': 'Réglages',

  'auth.signIn': 'Connexion',
  'auth.subtitle': 'Le même compte que sur le tableau de bord.',
  'auth.email': 'E-mail',
  'auth.password': 'Mot de passe',
  'auth.code': 'Code',
  'auth.continue': 'Continuer',
  'auth.codeSentTo': 'Nous avons envoyé un code à {address}.',
  'auth.emailCodeInstead': 'Recevoir un code par e-mail',
  'auth.sendAgain': 'Renvoyer le code',
  'auth.differentEmail': 'Utiliser une autre adresse',
  'auth.noAccount': 'Pas de compte ?',
  'auth.askAdmin': 'Un administrateur du club vous invite depuis le tableau de bord.',
  'auth.privacy': 'Confidentialité',
  'auth.terms': 'Conditions',
  'auth.support': 'Assistance',

  'club.notInClubTitle': "Vous n'êtes pas encore dans un club",
  'club.notInClubBody':
    'Un administrateur ajoute les membres depuis le tableau de bord RiseUp. Une fois ajouté, déconnectez-vous puis reconnectez-vous ici et tout sera là.',
  'club.whichClub': 'Quel club ?',
  'club.memberOfSeveral':
    'Vous êtes membre de plusieurs clubs. Vous pourrez changer plus tard dans les réglages.',
  'club.finding': 'Recherche de votre club',
  'club.checking': 'Vérification de votre club',

  'settings.title': 'Réglages',
  'settings.account': 'Compte',
  'settings.signedInAs': 'Connecté en tant que',
  'settings.club': 'Club',
  'settings.dashboardRole': 'Rôle sur le tableau de bord',
  'settings.thisDevice': 'Cet appareil',
  'settings.opensOnMatches': 'Ouvre sur la liste des matchs',
  'settings.opensOnCapture': 'Ouvre sur la captation',
  'settings.analyst': 'Analyste',
  'settings.operator': 'Opérateur',
  'settings.help': 'Aide',
  'settings.reportProblem': 'Signaler un problème',
  'settings.somethingBroken': "Quelque chose ne marche pas ou n'est pas clair",
  'settings.privacyPolicy': 'Politique de confidentialité',
  'settings.termsOfService': "Conditions d'utilisation",
  'settings.notifications': 'Notifications',
  'settings.deleteAccount': 'Supprimer le compte',
  'settings.deleteMyAccount': 'Supprimer mon compte',
  'settings.deleting': 'Suppression…',
};

export const ar: Dict = {
  'common.cancel': 'إلغاء',
  'common.back': 'رجوع',
  'common.next': 'التالي',
  'common.retry': 'إعادة المحاولة',
  'common.close': 'إغلاق',
  'common.loading': 'جارٍ التحميل',
  'common.signOut': 'تسجيل الخروج',

  'lang.label': 'اللغة',
  'lang.en': 'English',
  'lang.fr': 'Français',
  'lang.ar': 'العربية',
  'lang.subtitle': 'تُستخدم على هاتفك وفي لوحة التحكم.',
  'lang.restartTitle': 'يلزم إعادة التشغيل',
  'lang.restartBody':
    'تُقرأ العربية من اليمين إلى اليسار، ويجب إعادة تشغيل التطبيق ليُعرض بهذا الاتجاه. لن يضيع أي شيء أدخلته.',
  'lang.restartNow': 'إعادة التشغيل الآن',
  'lang.notNow': 'لاحقًا',
  'lang.syncFailed': 'تم الحفظ على هذا الهاتف. ستتم المزامنة عند عودة الاتصال.',

  'tabs.matches': 'المباريات',
  'tabs.capture': 'التصوير',
  'tabs.uploads': 'الرفع',
  'tabs.inbox': 'الإشعارات',
  'tabs.settings': 'الإعدادات',

  'auth.signIn': 'تسجيل الدخول',
  'auth.subtitle': 'نفس الحساب المستخدم في لوحة التحكم.',
  'auth.email': 'البريد الإلكتروني',
  'auth.password': 'كلمة المرور',
  'auth.code': 'الرمز',
  'auth.continue': 'متابعة',
  'auth.codeSentTo': 'أرسلنا رمزًا إلى {address}.',
  'auth.emailCodeInstead': 'أرسل لي رمزًا بالبريد',
  'auth.sendAgain': 'إعادة الإرسال',
  'auth.differentEmail': 'استخدام بريد آخر',
  'auth.noAccount': 'لا يوجد حساب؟',
  'auth.askAdmin': 'يقوم مسؤول النادي بدعوتك من لوحة التحكم.',
  'auth.privacy': 'الخصوصية',
  'auth.terms': 'الشروط',
  'auth.support': 'الدعم',

  'club.notInClubTitle': 'لست ضمن أي نادٍ بعد',
  'club.notInClubBody':
    'يضيف مسؤول النادي الأعضاء من لوحة تحكم RiseUp. بعد إضافتك، سجّل الخروج ثم الدخول مرة أخرى وسيكون كل شيء جاهزًا.',
  'club.whichClub': 'أي نادٍ؟',
  'club.memberOfSeveral': 'أنت عضو في أكثر من نادٍ. يمكنك التبديل لاحقًا من الإعدادات.',
  'club.finding': 'جارٍ البحث عن ناديك',
  'club.checking': 'جارٍ التحقق من ناديك',

  'settings.title': 'الإعدادات',
  'settings.account': 'الحساب',
  'settings.signedInAs': 'مسجّل الدخول باسم',
  'settings.club': 'النادي',
  'settings.dashboardRole': 'الدور في لوحة التحكم',
  'settings.thisDevice': 'هذا الجهاز',
  'settings.opensOnMatches': 'يفتح على قائمة المباريات',
  'settings.opensOnCapture': 'يفتح على التصوير',
  'settings.analyst': 'محلل',
  'settings.operator': 'مشغّل',
  'settings.help': 'المساعدة',
  'settings.reportProblem': 'الإبلاغ عن مشكلة',
  'settings.somethingBroken': 'شيء لا يعمل أو غير واضح',
  'settings.privacyPolicy': 'سياسة الخصوصية',
  'settings.termsOfService': 'شروط الاستخدام',
  'settings.notifications': 'الإشعارات',
  'settings.deleteAccount': 'حذف الحساب',
  'settings.deleteMyAccount': 'حذف حسابي',
  'settings.deleting': 'جارٍ الحذف…',
};
