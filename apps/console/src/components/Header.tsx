// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { Link } from "@tanstack/react-router";
import { useState, useCallback } from "react";
import { CircleAlert, LogIn, Menu, Monitor, Moon, Siren, Sun, X } from "lucide-react";
import { useI18n } from "../lib/i18n-context";
import { useTheme } from "../lib/theme-context";
import { LINKS } from "../lib/site";

const linkBase =
    "text-[15px] transition-colors max-lg:text-lg max-lg:py-2 flex items-center gap-1.5";

/** Language + theme switches. Shown in the top bar on desktop and inside the drawer on mobile. */
export function SiteToggles({ className = "" }: { className?: string }) {
    const { m, toggle: toggleLang } = useI18n();
    const { choice, cycle } = useTheme();
    const ThemeIcon = choice === "dark" ? Moon : choice === "light" ? Sun : Monitor;
    const themeLabel = m.nav.theme[choice];

    return (
        <div className={`flex items-center gap-1 ${className}`}>
            <button
                type="button"
                onClick={toggleLang}
                title={m.nav.switchLang}
                aria-label={m.nav.switchLang}
                className="h-9 min-w-9 rounded-lg px-2 text-sm font-semibold text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white"
            >
                {m.nav.langShort}
            </button>
            <button
                type="button"
                onClick={cycle}
                title={themeLabel}
                aria-label={themeLabel}
                className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white"
            >
                <ThemeIcon className="h-[18px] w-[18px]" />
            </button>
        </div>
    );
}

const Header: React.FC = () => {
    const { m } = useI18n();
    const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

    const toggleMobileMenu = useCallback(() => setIsMobileMenuOpen((prev) => !prev), []);
    const closeMobileMenu = useCallback(() => setIsMobileMenuOpen(false), []);

    return (
        <header className="fixed top-0 left-0 z-[1001] h-20 w-full border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950">
            <div className="mx-auto flex h-full max-w-7xl items-center justify-between px-4">
                <Link to="/" onClick={closeMobileMenu} className="flex flex-col leading-tight">
                    <span className="font-montserrat text-xl font-bold text-[#087f83] dark:text-teal-400">SynapseCity</span>
                    <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">{m.nav.tagline}</span>
                </Link>

                <div className="flex items-center gap-1 lg:hidden">
                    <SiteToggles />
                    <button
                        type="button"
                        className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                        onClick={toggleMobileMenu}
                        aria-label={m.nav.openMenu}
                        aria-expanded={isMobileMenuOpen}
                    >
                        <Menu className="h-5 w-5" />
                    </button>
                </div>

                <nav
                    className={`flex items-center gap-6 max-lg:fixed max-lg:top-0 max-lg:right-0 max-lg:z-[1002] max-lg:h-screen max-lg:w-4/5 max-lg:max-w-sm max-lg:flex-col max-lg:items-start max-lg:gap-1 max-lg:bg-white max-lg:px-6 max-lg:pt-20 max-lg:shadow-2xl max-lg:transition-transform max-lg:duration-300 dark:max-lg:bg-slate-950 ${
                        isMobileMenuOpen ? "max-lg:translate-x-0" : "max-lg:translate-x-full"
                    }`}
                >
                    <button
                        type="button"
                        className="absolute top-4 right-4 hidden h-10 w-10 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 max-lg:flex dark:text-slate-300 dark:hover:bg-slate-800"
                        onClick={closeMobileMenu}
                        aria-label={m.nav.closeMenu}
                    >
                        <X className="h-6 w-6" />
                    </button>

                    <Link
                        to="/about"
                        onClick={closeMobileMenu}
                        className={`${linkBase} text-slate-600 hover:text-sky-600 dark:text-slate-300 dark:hover:text-sky-400`}
                    >
                        {m.nav.about}
                    </Link>
                    <Link
                        to="/docs"
                        onClick={closeMobileMenu}
                        className={`${linkBase} text-slate-600 hover:text-sky-600 dark:text-slate-300 dark:hover:text-sky-400`}
                    >
                        {m.nav.docs}
                    </Link>
                    <Link
                        to="/public/report"
                        onClick={closeMobileMenu}
                        className={`${linkBase} font-medium text-amber-700 hover:text-amber-800 dark:text-amber-400 dark:hover:text-amber-300`}
                    >
                        <CircleAlert className="h-4 w-4" />
                        {m.nav.report}
                    </Link>
                    <a
                        href={LINKS.sos}
                        onClick={closeMobileMenu}
                        className={`${linkBase} font-medium text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300`}
                    >
                        <Siren className="h-4 w-4" />
                        {m.nav.sos}
                    </a>
                    <Link
                        to="/login"
                        onClick={closeMobileMenu}
                        className={`${linkBase} text-slate-600 hover:text-sky-600 dark:text-slate-300 dark:hover:text-sky-400`}
                    >
                        <LogIn className="h-4 w-4" />
                        {m.nav.login}
                    </Link>

                    <SiteToggles className="max-lg:hidden" />

                    <Link
                        to="/map"
                        search={{ assetId: undefined }}
                        onClick={closeMobileMenu}
                        className="flex h-10 items-center rounded-full bg-linear-to-r from-cyan-500 to-blue-500 px-6 text-[15px] font-semibold text-white shadow-md shadow-cyan-500/25 transition hover:shadow-lg max-lg:mt-4 max-lg:w-full max-lg:justify-center"
                    >
                        {m.nav.start}
                    </Link>
                </nav>

                {isMobileMenuOpen && (
                    <button
                        type="button"
                        aria-label={m.nav.closeMenu}
                        onClick={closeMobileMenu}
                        className="fixed inset-0 z-[1001] bg-black/40 lg:hidden"
                    />
                )}
            </div>
        </header>
    );
};

export default Header;
