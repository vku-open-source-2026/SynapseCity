// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
    Activity,
    ArrowRight,
    Building2,
    ClipboardList,
    Code2,
    Download,
    Gauge,
    MapPin,
    Users,
    Wallet,
    Wrench,
    Database,
} from "lucide-react";
import { getAssets } from "../api";
import AIChatWidget from "../components/AIChatWidget";
import Footer from "../components/Footer";
import Header from "../components/Header";
import mapImage from "../assets/map.png";
import { usePWA } from "../hooks/usePWA";
import { useI18n } from "../lib/i18n";
import { LINKS } from "../lib/site";

const FEATURE_ICONS = [MapPin, Wrench, Activity, Gauge, Wallet, Database];
const AUDIENCE_ICONS = [Users, Building2, Code2];

const card =
    "rounded-2xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900";
const sectionTitle = "text-2xl font-bold text-slate-900 md:text-3xl dark:text-white";
const bodyText = "text-slate-600 dark:text-slate-300";

const HomePage = () => {
    const { m, lang } = useI18n();
    const h = m.home;
    const { canShowInstallButton, promptInstall } = usePWA();
    const [assetCount, setAssetCount] = useState<number | null>(null);
    const [loadingAssets, setLoadingAssets] = useState(true);

    useEffect(() => {
        let cancelled = false;
        getAssets()
            .then((assets) => {
                if (!cancelled) setAssetCount(assets.length);
            })
            .catch(() => {
                if (!cancelled) setAssetCount(null);
            })
            .finally(() => {
                if (!cancelled) setLoadingAssets(false);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    // Only real numbers are shown. If the API is unreachable the badge is hidden.
    const assetCountLabel =
        assetCount !== null
            ? h.assetCount(new Intl.NumberFormat(lang === "vi" ? "vi-VN" : "en-US").format(assetCount))
            : loadingAssets
            ? h.assetLoading
            : null;

    const audienceLinks = [
        <Link key="r" to="/public/report" className="inline-flex items-center gap-1 text-sm font-semibold text-teal-700 hover:underline dark:text-teal-400">
            {h.audiences[0].cta} <ArrowRight className="h-4 w-4" />
        </Link>,
        <Link key="l" to="/login" className="inline-flex items-center gap-1 text-sm font-semibold text-teal-700 hover:underline dark:text-teal-400">
            {h.audiences[1].cta} <ArrowRight className="h-4 w-4" />
        </Link>,
        <Link key="d" to="/docs" className="inline-flex items-center gap-1 text-sm font-semibold text-teal-700 hover:underline dark:text-teal-400">
            {h.audiences[2].cta} <ArrowRight className="h-4 w-4" />
        </Link>,
    ];

    return (
        <div className="min-h-screen bg-white text-slate-900 dark:bg-slate-950 dark:text-slate-100">
            <Header />
            <main className="pt-20">
                {/* Hero */}
                <section className="mx-auto grid max-w-7xl items-center gap-12 px-4 py-16 sm:px-6 md:grid-cols-2 md:py-24 lg:px-8">
                    <div className="space-y-6">
                        <span className="inline-block rounded-full border border-teal-200 bg-teal-50 px-3 py-1 text-sm font-medium text-teal-800 dark:border-teal-900 dark:bg-teal-950 dark:text-teal-300">
                            {h.badge}
                        </span>
                        <h1 className="text-4xl font-bold leading-tight text-slate-900 md:text-5xl dark:text-white">
                            {h.titleStart}{" "}
                            <span className="text-teal-700 dark:text-teal-400">{h.titleHighlight}</span>
                        </h1>
                        <p className={`text-lg leading-relaxed ${bodyText}`}>{h.lead}</p>
                        <div className="flex flex-col gap-3 pt-2 sm:flex-row">
                            <Link
                                to="/map"
                                search={{ assetId: undefined }}
                                className="inline-flex items-center justify-center rounded-lg bg-teal-700 px-6 py-3 font-semibold text-white hover:bg-teal-800 dark:bg-teal-500 dark:text-slate-950 dark:hover:bg-teal-400"
                            >
                                {h.ctaMap}
                                <ArrowRight className="ml-2 h-4 w-4" />
                            </Link>
                            <Link
                                to="/public/report"
                                className="inline-flex items-center justify-center rounded-lg border border-amber-300 bg-amber-50 px-6 py-3 font-semibold text-amber-800 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300 dark:hover:bg-amber-900"
                            >
                                <ClipboardList className="mr-2 h-4 w-4" />
                                {h.ctaReport}
                            </Link>
                            {canShowInstallButton && (
                                <button
                                    type="button"
                                    onClick={promptInstall}
                                    className="inline-flex items-center justify-center rounded-lg border border-slate-300 px-6 py-3 font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                                >
                                    <Download className="mr-2 h-4 w-4" />
                                    {h.install}
                                </button>
                            )}
                        </div>
                    </div>
                    <div className="relative">
                        <Link to="/map" search={{ assetId: undefined }} className="block overflow-hidden rounded-2xl border border-slate-200 shadow-xl dark:border-slate-800">
                            <img src={mapImage} alt={h.mapAlt} className="h-auto w-full object-cover" />
                        </Link>
                        {assetCountLabel && (
                            <div className="absolute -bottom-5 left-4 flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 shadow-md dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
                                <span className={`h-2.5 w-2.5 rounded-full ${assetCount !== null ? "bg-emerald-500" : "bg-slate-400"}`} />
                                {assetCountLabel}
                            </div>
                        )}
                    </div>
                </section>

                {/* Audiences */}
                <section className="border-y border-slate-200 bg-slate-50 py-16 md:py-20 dark:border-slate-800 dark:bg-slate-900/40">
                    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
                        <h2 className={sectionTitle}>{h.audienceTitle}</h2>
                        <div className="mt-8 grid gap-6 md:grid-cols-3">
                            {h.audiences.map((a, i) => {
                                const Icon = AUDIENCE_ICONS[i];
                                return (
                                    <div key={a.title} className={`${card} flex flex-col`}>
                                        <Icon className="h-6 w-6 text-teal-700 dark:text-teal-400" />
                                        <h3 className="mt-4 text-lg font-semibold text-slate-900 dark:text-white">{a.title}</h3>
                                        <p className={`mt-2 flex-1 text-sm leading-relaxed ${bodyText}`}>{a.text}</p>
                                        <div className="mt-4">{audienceLinks[i]}</div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </section>

                {/* Incident flow */}
                <section className="mx-auto max-w-7xl px-4 py-16 sm:px-6 md:py-20 lg:px-8">
                    <h2 className={sectionTitle}>{h.stepsTitle}</h2>
                    <p className={`mt-2 ${bodyText}`}>{h.stepsLead}</p>
                    <ol className="mt-8 grid gap-6 md:grid-cols-4">
                        {h.steps.map((s, i) => (
                            <li key={s.title} className="relative border-l-2 border-teal-600 pl-5 dark:border-teal-500">
                                <span className="text-sm font-semibold text-teal-700 dark:text-teal-400">{String(i + 1).padStart(2, "0")}</span>
                                <h3 className="mt-1 font-semibold text-slate-900 dark:text-white">{s.title}</h3>
                                <p className={`mt-2 text-sm leading-relaxed ${bodyText}`}>{s.text}</p>
                            </li>
                        ))}
                    </ol>
                </section>

                {/* Features */}
                <section className="border-t border-slate-200 py-16 md:py-20 dark:border-slate-800">
                    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
                        <h2 className={sectionTitle}>{h.featuresTitle}</h2>
                        <div className="mt-8 grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
                            {h.features.map((f, i) => {
                                const Icon = FEATURE_ICONS[i];
                                return (
                                    <div key={f.title} className="flex gap-4">
                                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-teal-50 text-teal-700 dark:bg-teal-950 dark:text-teal-400">
                                            <Icon className="h-5 w-5" />
                                        </div>
                                        <div>
                                            <h3 className="font-semibold text-slate-900 dark:text-white">{f.title}</h3>
                                            <p className={`mt-1 text-sm leading-relaxed ${bodyText}`}>{f.text}</p>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </section>

                {/* Open data + open source */}
                <section className="border-t border-slate-200 bg-slate-50 py-16 md:py-20 dark:border-slate-800 dark:bg-slate-900/40">
                    <div className="mx-auto grid max-w-7xl gap-6 px-4 sm:px-6 md:grid-cols-2 lg:px-8">
                        <div className={card}>
                            <h2 className="text-xl font-bold text-slate-900 dark:text-white">{h.openDataTitle}</h2>
                            <p className={`mt-3 text-sm leading-relaxed ${bodyText}`}>{h.openDataText}</p>
                            <div className="mt-5 flex flex-wrap gap-x-6 gap-y-2 text-sm font-semibold">
                                <Link to="/docs" className="text-teal-700 hover:underline dark:text-teal-400">{h.openDataApi}</Link>
                                <a href={LINKS.dataLicense} target="_blank" rel="noopener noreferrer" className="text-teal-700 hover:underline dark:text-teal-400">
                                    {h.openDataLicense}
                                </a>
                            </div>
                        </div>
                        <div className={card}>
                            <h2 className="text-xl font-bold text-slate-900 dark:text-white">{h.openSourceTitle}</h2>
                            <p className={`mt-3 text-sm leading-relaxed ${bodyText}`}>{h.openSourceText}</p>
                            <div className="mt-5 flex flex-wrap gap-x-6 gap-y-2 text-sm font-semibold">
                                {[
                                    [LINKS.repo, h.openSourceLinks.repo],
                                    [LINKS.buildFromSource, h.openSourceLinks.build],
                                    [LINKS.changelog, h.openSourceLinks.changelog],
                                    [LINKS.issues, h.openSourceLinks.issues],
                                ].map(([href, label]) => (
                                    <a key={href} href={href} target="_blank" rel="noopener noreferrer" className="text-teal-700 hover:underline dark:text-teal-400">
                                        {label}
                                    </a>
                                ))}
                            </div>
                        </div>
                    </div>
                </section>
            </main>
            <Footer />
            <AIChatWidget />
        </div>
    );
};

export default HomePage;
