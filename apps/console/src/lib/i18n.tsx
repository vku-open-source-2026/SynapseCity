// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
    type ReactNode,
} from "react";
import { vi, type Messages } from "../locales/vi";
import { en } from "../locales/en";

export type Lang = "vi" | "en";

const STORAGE_KEY = "synapsecity.lang";
const DICTS: Record<Lang, Messages> = { vi, en };

function readLang(): Lang {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved === "vi" || saved === "en") return saved;
    } catch {
        /* storage blocked */
    }
    // Vietnamese is the default audience; only switch for browsers that ask for something else.
    const browser = typeof navigator !== "undefined" ? navigator.language.toLowerCase() : "vi";
    return browser.startsWith("vi") || !browser ? "vi" : "en";
}

interface I18nContextValue {
    lang: Lang;
    m: Messages;
    setLang: (next: Lang) => void;
    toggle: () => void;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
    const [lang, setLangState] = useState<Lang>(readLang);

    useEffect(() => {
        document.documentElement.lang = lang;
        document.title = DICTS[lang].meta.title;
        document.querySelector('meta[name="description"]')?.setAttribute("content", DICTS[lang].meta.description);
    }, [lang]);

    const setLang = useCallback((next: Lang) => {
        setLangState(next);
        try {
            localStorage.setItem(STORAGE_KEY, next);
        } catch {
            /* ignore */
        }
    }, []);

    const toggle = useCallback(() => setLang(lang === "vi" ? "en" : "vi"), [lang, setLang]);

    const value = useMemo(() => ({ lang, m: DICTS[lang], setLang, toggle }), [lang, setLang, toggle]);
    return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
    const ctx = useContext(I18nContext);
    if (!ctx) throw new Error("useI18n must be used inside <LanguageProvider>");
    return ctx;
}
