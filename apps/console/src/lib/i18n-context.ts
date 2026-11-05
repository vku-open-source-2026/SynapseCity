// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createContext, useContext } from "react";
import type { Messages } from "../locales/vi";

export type Lang = "vi" | "en";

export interface I18nContextValue {
    lang: Lang;
    m: Messages;
    /** Every language's copy, for widths that must not change on a language switch (StableLabel). */
    dicts: Record<Lang, Messages>;
    setLang: (next: Lang) => void;
    toggle: () => void;
}

export const I18nContext = createContext<I18nContextValue | null>(null);

/** Current language and its copy. Provided by <LanguageProvider> in src/lib/i18n.tsx. */
export function useI18n(): I18nContextValue {
    const ctx = useContext(I18nContext);
    if (!ctx) throw new Error("useI18n must be used inside <LanguageProvider>");
    return ctx;
}
