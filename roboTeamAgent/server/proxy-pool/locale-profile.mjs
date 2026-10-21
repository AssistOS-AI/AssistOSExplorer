// Locale of a proxied workstation, derived from the address the internet sees through its proxy.
// A country code does not name a timezone (the United States has several), so the timezone comes
// from a geolocation lookup of the exit address. The language comes from a fixed map of that
// country: the lookup does not name a language, and an unmapped country stays English.

export const NEUTRAL_LOCALE_PROFILE = Object.freeze({ timezone: 'UTC', locale: 'en_US.UTF-8', lang: 'en-US' });
const TIMEZONE = /^[A-Za-z0-9_+-]{1,14}(?:\/[A-Za-z0-9_+-]{1,32}){1,2}$/u;
const COUNTRY = /^[A-Z]{2}$/u;

// One locale per country that ships in the Debian locales of both GUI images. Countries absent
// here, and every country whose usual language is not in that set, use English.
const COUNTRY_LOCALES = Object.freeze({
    AE: 'ar_AE.UTF-8', SA: 'ar_SA.UTF-8',
    CN: 'zh_CN.UTF-8', TW: 'zh_TW.UTF-8', HK: 'zh_HK.UTF-8',
    JP: 'ja_JP.UTF-8', KR: 'ko_KR.UTF-8',
    DE: 'de_DE.UTF-8', AT: 'de_AT.UTF-8', CH: 'de_CH.UTF-8', LI: 'de_LI.UTF-8', LU: 'de_LU.UTF-8',
    FR: 'fr_FR.UTF-8', BE: 'fr_BE.UTF-8', MC: 'fr_MC.UTF-8',
    ES: 'es_ES.UTF-8', MX: 'es_MX.UTF-8', AR: 'es_AR.UTF-8', CO: 'es_CO.UTF-8', CL: 'es_CL.UTF-8',
    NL: 'nl_NL.UTF-8', IT: 'it_IT.UTF-8', PT: 'pt_PT.UTF-8', BR: 'pt_BR.UTF-8',
    RU: 'ru_RU.UTF-8', PL: 'pl_PL.UTF-8', TR: 'tr_TR.UTF-8',
    SE: 'sv_SE.UTF-8', NO: 'nb_NO.UTF-8', DK: 'da_DK.UTF-8', FI: 'fi_FI.UTF-8',
    GR: 'el_GR.UTF-8', IL: 'he_IL.UTF-8', RO: 'ro_RO.UTF-8', HU: 'hu_HU.UTF-8',
    CZ: 'cs_CZ.UTF-8', SK: 'sk_SK.UTF-8', UA: 'uk_UA.UTF-8',
    GB: 'en_GB.UTF-8', IE: 'en_IE.UTF-8', AU: 'en_AU.UTF-8', NZ: 'en_NZ.UTF-8',
    CA: 'en_CA.UTF-8', IN: 'en_IN.UTF-8', ZA: 'en_ZA.UTF-8', US: 'en_US.UTF-8',
});

export function localeForCountry(country) {
    const code = String(country || '').toUpperCase();
    const locale = COUNTRY_LOCALES[code] || NEUTRAL_LOCALE_PROFILE.locale;
    return { locale, lang: locale.replace('_', '-').replace('.UTF-8', '') };
}

export function fallbackLocaleProfile() {
    return { ...NEUTRAL_LOCALE_PROFILE };
}

// Keeps only a timezone the container can pass to TZ and a country the locale map understands.
export function localeProfileFromLookup(body, fallbackCountry = null) {
    const timezone = TIMEZONE.test(String(body?.timezone?.id || '')) ? body.timezone.id : NEUTRAL_LOCALE_PROFILE.timezone;
    const reported = String(body?.country_code || '').toUpperCase();
    const country = COUNTRY.test(reported) ? reported : (COUNTRY.test(String(fallbackCountry || '')) ? fallbackCountry : null);
    return { timezone, ...localeForCountry(country) };
}
