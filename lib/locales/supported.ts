/**
 * The languages this instance supports (the app UI is available in all of
 * them). Used by the instance API endpoints and as the default for the
 * configurable `languages` instance setting.
 */
export const SUPPORTED_LANGUAGES: { code: string; name: string; native_name: string }[] = [
  { code: "en", name: "English", native_name: "English" },
  { code: "es", name: "Spanish", native_name: "Español" },
  { code: "fr", name: "French", native_name: "Français" },
  { code: "de", name: "German", native_name: "Deutsch" },
  { code: "it", name: "Italian", native_name: "Italiano" },
  { code: "ja", name: "Japanese", native_name: "日本語" },
  { code: "ko", name: "Korean", native_name: "한국어" },
  { code: "pt", name: "Portuguese", native_name: "Português" },
  { code: "ru", name: "Russian", native_name: "Русский" },
  { code: "zh-Hans", name: "Chinese (Simplified)", native_name: "简体中文" },
];

export const SUPPORTED_LANGUAGE_CODES: string[] = SUPPORTED_LANGUAGES.map((l) => l.code);