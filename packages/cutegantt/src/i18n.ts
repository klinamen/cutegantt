import i18next from 'i18next';
import en from './locales/en.js';
import it from './locales/it.js';
import type { ZodIssue } from 'zod';

export const languages = ['en', 'it'];
const resources: Record<string, { translation: typeof en }> = {
  en: { translation: en },
  it: { translation: it },
};
for (const [lang, resource] of Object.entries(resources)) {
  const labels = resource.translation.monthLabels;
  if (
    labels !== undefined &&
    (!Array.isArray(labels) ||
      labels.length !== 12 ||
      labels.some((label) => typeof label !== 'string' || !label.trim()))
  ) {
    throw new Error(`locales/${lang}.json: monthLabels must contain 12 nonempty strings.`);
  }
}
const instance = i18next.createInstance();
instance.init({
  resources,
  lng: 'en',
  fallbackLng: 'en',
  supportedLngs: languages,
  initAsync: false,
  interpolation: { escapeValue: false },
});

export function translator(lang = 'en') {
  if (!languages.includes(lang))
    throw new Error(instance.t('errors.language', { lng: 'en', lang }));
  return instance.getFixedT(lang);
}

export interface PlanError extends Error {
  translationKey?: string;
  parameters?: Record<string, unknown>;
  path?: PropertyKey[];
  issues?: ZodIssue[];
  file?: string;
  prefix?: string;
}

export function localizedError(key: string, parameters: Record<string, unknown> = {}): PlanError {
  return Object.assign(new Error(translator()(`errors.${key}`, parameters)), {
    translationKey: `errors.${key}`,
    parameters,
  });
}

export function canonicalDateLocale(value: unknown) {
  try {
    if (typeof value !== 'string' || !value.length) throw new Error();
    const [locale] = Intl.getCanonicalLocales(value);
    if (!Intl.DateTimeFormat.supportedLocalesOf([locale]).length) throw new Error();
    return locale;
  } catch {
    throw localizedError('dateLocale');
  }
}

export function dateFormatters(lang = 'en', dateLocale?: string) {
  translator(lang);
  const locale = canonicalDateLocale(dateLocale ?? (lang === 'it' ? 'it-IT' : 'en-GB'));
  const common = { timeZone: 'UTC', calendar: 'gregory', numberingSystem: 'latn' };
  const formatter = (options: Intl.DateTimeFormatOptions) => {
    const instance = new Intl.DateTimeFormat(locale, { ...common, ...options });
    return (value: string | number) =>
      instance.format(typeof value === 'string' ? Date.parse(`${value}T00:00:00Z`) : value);
  };
  const monthLabels = resources[lang].translation.monthLabels;
  const monthFormatter = new Intl.DateTimeFormat(locale, {
    ...common,
    month: 'short',
    year: 'numeric',
  });
  return {
    locale,
    short: formatter({ day: '2-digit', month: '2-digit' }),
    full: formatter({ day: '2-digit', month: '2-digit', year: 'numeric' }),
    month: (value: string | number) => {
      const stamp = typeof value === 'string' ? Date.parse(`${value}T00:00:00Z`) : value;
      if (!monthLabels) return monthFormatter.format(stamp);
      return monthFormatter
        .formatToParts(stamp)
        .map((part) =>
          part.type === 'month' ? monthLabels[new Date(stamp).getUTCMonth()] : part.value,
        )
        .join('');
    },
  };
}
