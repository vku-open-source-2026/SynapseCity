// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { vi, type Messages } from "../locales/vi";
import { en } from "../locales/en";
import { I18nContext, type Lang } from "./i18n-context";

const STORAGE_KEY = "synapsecity.lang";

/**
 * Vietnamese words are written as separate syllables, so browsers happily
 * break "dữ liệu" into "dữ / liệu". Joining common compounds with a
 * non-breaking space keeps each word on one line.
 */
const VI_COMPOUNDS = [
    "mã nguồn mở", "mã nguồn", "dữ liệu", "hạ tầng", "đô thị", "sự cố", "bản đồ", "báo cáo",
    "người dân", "tài sản", "bảo trì", "cảm biến", "ngân sách", "tài khoản", "công khai",
    "giấy phép", "vị trí", "nền tảng", "thông minh", "chính quyền", "địa phương", "cán bộ",
    "kỹ thuật viên", "phát triển", "doanh nghiệp", "hệ thống", "đơn vị", "quản lý", "giám sát",
    "trạng thái", "xử lý", "nguy hiểm", "tra cứu", "trải nghiệm", "đóng góp", "Việt Nam",
    "chúng tôi", "minh bạch", "tiếp cận", "ứng dụng", "thời gian thực", "tương tác",
];
const COMPOUND_RE = new RegExp(
    VI_COMPOUNDS.sort((a, b) => b.length - a.length).map((w) => w.replace(/ /g, "\\s")).join("|"),
    "giu",
);

function keepCompounds<T>(value: T): T {
    if (typeof value === "string") {
        return value.replace(COMPOUND_RE, (word) => word.replace(/\s/g, " ")) as T;
    }
    if (Array.isArray(value)) return value.map(keepCompounds) as T;
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, keepCompounds(v)])) as T;
    }
    return value;
}

const DICTS: Record<Lang, Messages> = { vi: keepCompounds(vi), en };

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

    const value = useMemo(() => ({ lang, m: DICTS[lang], dicts: DICTS, setLang, toggle }), [lang, setLang, toggle]);
    return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
