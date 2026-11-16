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
    Database,
    Download,
    Gauge,
    MapPin,
    Search,
    Users,
    Wallet,
    Wrench,
} from "lucide-react";
import { publicApi } from "../api/public";
import AIChatWidget from "../components/AIChatWidget";
import Footer from "../components/Footer";
import Header from "../components/Header";
import mapImage from "../assets/map.png";
import { useI18n } from "../lib/i18n-context";
import { LINKS } from "../lib/site";
import { WORKSPACE_URL } from "../lib/workspace";

const FEATURE_ICONS = [MapPin, Wrench, Activity, Gauge, Wallet, Database];

/** Each audience gets its own accent so the three cards read as different paths. */
const AUDIENCES = [
    { icon: Users, to: "/public/report", external: false, accent: "from-amber-400 to-orange-500", bar: "bg-amber-400", link: "text-amber-700 dark:text-amber-400" },
    // Operators work in the Tier-2 DX workspace; Tier 3 stays public-only.
    { icon: Building2, to: WORKSPACE_URL, external: true, accent: "from-cyan-400 to-blue-500", bar: "bg-sky-500", link: "text-sky-700 dark:text-sky-400" },
    { icon: Code2, to: "/docs", external: false, accent: "from-emerald-400 to-teal-500", bar: "bg-emerald-500", link: "text-emerald-700 dark:text-emerald-400" },
] as const;

const gradientText = "bg-linear-to-r from-sky-500 to-cyan-400 bg-clip-text text-transparent";
const primaryBtn =
    "inline-flex items-center justify-center whitespace-nowrap rounded-full bg-linear-to-r from-cyan-500 to-blue-500 px-5 py-3 text-[15px] font-semibold text-white shadow-lg shadow-cyan-500/25 transition hover:shadow-xl hover:shadow-cyan-500/40";
const kicker =
    "inline-flex items-center gap-2 rounded-full bg-sky-100 px-3 py-1 text-sm font-semibold text-sky-700 dark:bg-sky-950 dark:text-sky-300";
const sectionTitle = "mt-4 text-3xl font-bold text-balance text-slate-900 md:text-4xl dark:text-white";
const sectionLead = "mx-auto mt-3 max-w-2xl text-lg text-balance text-slate-600 dark:text-slate-300";
const bodyText = "text-pretty text-slate-600 dark:text-slate-300";

function SectionHeader({ kick, title, lead }: { kick: string; title: string; lead?: string }) {
    return (
        <div className="mx-auto max-w-3xl text-center">
            <span className={kicker}>{kick}</span>
            <h2 className={sectionTitle}>{title}</h2>
            {lead ? <p className={sectionLead}>{lead}</p> : null}
        </div>
    );
}

const HomePage = () => {
    const { m, lang } = useI18n();
    const h = m.home;
    const [assetCount, setAssetCount] = useState<number | null>(null);
    const [loadingAssets, setLoadingAssets] = useState(true);

    useEffect(() => {
        let cancelled = false;
        publicApi
            .countPublicAssets({ include_inactive: true })
            .then((count) => {
                // Hide the badge rather than advertise an empty map.
                if (!cancelled) setAssetCount(count > 0 ? count : null);
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

    return (
        <div className="min-h-screen bg-white text-slate-900 dark:bg-slate-950 dark:text-slate-100">
            <Header />
            <main className="pt-20">
                {/* Hero */}
                <section className="relative overflow-hidden">
                    <div className="pointer-events-none absolute -top-40 right-0 h-[28rem] w-[28rem] rounded-full bg-cyan-200/40 blur-3xl dark:bg-cyan-500/10" />
                    <div className="pointer-events-none absolute -bottom-40 -left-20 h-[24rem] w-[24rem] rounded-full bg-sky-200/40 blur-3xl dark:bg-sky-500/10" />
                    <div className="relative mx-auto grid max-w-7xl items-center gap-14 px-4 py-16 sm:px-6 md:py-24 lg:grid-cols-[1.4fr_1fr] lg:gap-8 lg:px-8 xl:grid-cols-2 xl:gap-14">
                        <div className="mx-auto max-w-2xl space-y-6 text-center lg:mx-0 lg:max-w-none lg:text-left">
                            <span className={kicker}>{h.badge}</span>
                            <h1 className="text-4xl font-bold leading-tight text-balance text-slate-900 md:text-5xl lg:text-6xl dark:text-white">
                                {h.titleStart} <span className={gradientText}>{h.titleHighlight}</span>
                            </h1>
                            <p className={`text-lg leading-relaxed ${bodyText}`}>{h.lead}</p>
                            <div className="flex flex-col justify-center gap-3 pt-2 sm:flex-row sm:flex-nowrap lg:justify-start">
                                <Link to="/map" search={{ assetId: undefined }} className={primaryBtn}>
                                    {h.ctaMap}
                                    <ArrowRight className="ml-2 h-4 w-4" />
                                </Link>
                                <Link
                                    to="/public/report"
                                    className="inline-flex items-center justify-center whitespace-nowrap rounded-full border-2 border-amber-400 px-5 py-3 text-[15px] font-semibold text-amber-700 transition hover:bg-amber-50 dark:text-amber-300 dark:hover:bg-amber-950"
                                >
                                    <ClipboardList className="mr-2 h-4 w-4" />
                                    {h.ctaReport}
                                </Link>
                                <a
                                    href={LINKS.androidApk}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center justify-center whitespace-nowrap rounded-full border border-slate-300 px-5 py-3 text-[15px] font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                                >
                                    <Download className="mr-2 h-4 w-4" />
                                    {h.install}
                                </a>
                            </div>
                        </div>
                        <div className="relative mx-auto w-full max-w-2xl lg:max-w-none">
                            <div className="rounded-3xl bg-linear-to-br from-sky-100 to-cyan-100 p-5 shadow-2xl shadow-sky-200/60 dark:from-sky-950 dark:to-cyan-950 dark:shadow-none">
                                <Link
                                    to="/map"
                                    search={{ assetId: undefined }}
                                    className="group relative block overflow-hidden rounded-2xl"
                                >
                                    <img src={mapImage} alt={h.mapAlt} className="h-auto w-full object-cover transition duration-500 group-hover:scale-105" />
                                    <span className="absolute inset-0 flex items-center justify-center bg-slate-900/30 opacity-0 transition group-hover:opacity-100">
                                        <span className="rounded-full bg-white px-5 py-2 font-semibold text-slate-900 shadow dark:bg-white dark:text-slate-900">{h.mapHover}</span>
                                    </span>
                                </Link>
                            </div>
                            {assetCountLabel && (
                                <div className="absolute -bottom-5 left-6 flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 shadow-lg dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
                                    <span className={`h-2.5 w-2.5 rounded-full ${assetCount !== null ? "bg-emerald-500" : "bg-slate-400"}`} />
                                    {assetCountLabel}
                                </div>
                            )}
                        </div>
                    </div>
                </section>

                {/* Audiences */}
                <section className="bg-slate-50 py-20 dark:bg-slate-900/50">
                    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
                        <SectionHeader kick={h.audienceKicker} title={h.audienceTitle} lead={h.audienceLead} />
                        <div className="mt-12 grid gap-6 md:grid-cols-3">
                            {h.audiences.map((a, i) => {
                                const style = AUDIENCES[i];
                                const Icon = style.icon;
                                return (
                                    <div
                                        key={a.title}
                                        className="relative flex flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white p-7 text-center shadow-sm transition hover:-translate-y-1 hover:shadow-lg dark:border-slate-800 dark:bg-slate-900"
                                    >
                                        <span className={`absolute inset-x-0 top-0 h-1 ${style.bar}`} />
                                        <span className={`mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-linear-to-br ${style.accent} text-white shadow-md`}>
                                            <Icon className="h-7 w-7" />
                                        </span>
                                        <h3 className="mt-5 text-xl font-semibold text-slate-900 dark:text-white">{a.title}</h3>
                                        <p className={`mt-3 flex-1 leading-relaxed ${bodyText}`}>{a.text}</p>
                                        <a href={style.to} className={`mt-5 inline-flex items-center justify-center gap-1 font-semibold hover:underline ${style.link}`}>
                                            {a.cta} <ArrowRight className="h-4 w-4" />
                                        </a>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </section>

                {/* Citizen reporting */}
                <section className="border-y border-amber-100 bg-linear-to-br from-amber-50 via-white to-orange-50 py-20 dark:border-amber-950 dark:from-amber-950/30 dark:via-slate-950 dark:to-orange-950/20">
                    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
                        <div className="mx-auto max-w-3xl text-center">
                            <span className="inline-flex items-center gap-2 rounded-full bg-amber-100 px-3 py-1 text-sm font-semibold text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                                <ClipboardList className="h-4 w-4" />
                                {h.stepsKicker}
                            </span>
                            <h2 className={sectionTitle}>
                                {h.stepsTitle}{" "}
                                <span className="bg-linear-to-r from-amber-500 to-orange-500 bg-clip-text text-transparent">{h.stepsHighlight}</span>
                            </h2>
                            <p className={sectionLead}>{h.stepsLead}</p>
                        </div>
                        <ol className="relative mt-14 grid gap-10 md:grid-cols-4 md:gap-6">
                            <span className="absolute top-6 right-[12.5%] left-[12.5%] hidden h-0.5 bg-amber-200 md:block dark:bg-amber-900" aria-hidden />
                            {h.steps.map((s, i) => (
                                <li key={s.title} className="relative text-center">
                                    <span className="relative mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-linear-to-br from-amber-400 to-orange-500 text-lg font-bold text-white shadow-md ring-4 ring-white dark:ring-slate-950">
                                        {i + 1}
                                    </span>
                                    <h3 className="mt-4 text-lg font-semibold text-slate-900 dark:text-white">{s.title}</h3>
                                    <p className={`mx-auto mt-2 max-w-xs text-sm leading-relaxed ${bodyText}`}>{s.text}</p>
                                </li>
                            ))}
                        </ol>
                        <div className="mt-12 flex flex-col justify-center gap-3 sm:flex-row">
                            <Link
                                to="/public/report"
                                className="inline-flex items-center justify-center whitespace-nowrap rounded-full bg-linear-to-r from-amber-500 to-orange-500 px-7 py-3 font-semibold text-white shadow-lg shadow-amber-500/25 transition hover:shadow-xl"
                            >
                                <ClipboardList className="mr-2 h-4 w-4" />
                                {h.stepsCta}
                                <ArrowRight className="ml-2 h-4 w-4" />
                            </Link>
                            <Link
                                to="/public/report"
                                hash="lookup-status"
                                className="inline-flex items-center justify-center whitespace-nowrap rounded-full border border-amber-300 bg-white px-7 py-3 font-semibold text-amber-800 hover:bg-amber-50 dark:border-amber-800 dark:bg-transparent dark:text-amber-300 dark:hover:bg-amber-950"
                            >
                                <Search className="mr-2 h-4 w-4" />
                                {h.stepsLookup}
                            </Link>
                        </div>
                    </div>
                </section>

                {/* Features */}
                <section className="py-20">
                    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
                        <SectionHeader kick={h.featuresKicker} title={h.featuresTitle} lead={h.featuresLead} />
                        <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                            {h.features.map((f, i) => {
                                const Icon = FEATURE_ICONS[i];
                                return (
                                    <div
                                        key={f.title}
                                        className="rounded-2xl border border-slate-200 bg-white p-7 text-center transition hover:border-sky-300 hover:shadow-lg dark:border-slate-800 dark:bg-slate-900 dark:hover:border-sky-800"
                                    >
                                        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-linear-to-br from-cyan-400 to-blue-500 text-white shadow-md">
                                            <Icon className="h-6 w-6" />
                                        </span>
                                        <h3 className="mt-4 text-lg font-semibold text-slate-900 dark:text-white">{f.title}</h3>
                                        <p className={`mt-2 text-sm leading-relaxed ${bodyText}`}>{f.text}</p>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </section>

                {/* Open data + open source */}
                <section className="bg-slate-50 py-20 dark:bg-slate-900/50">
                    <div className="mx-auto grid max-w-6xl gap-6 px-4 sm:px-6 md:grid-cols-2 lg:px-8">
                        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
                            <div className="h-1.5 bg-linear-to-r from-emerald-400 to-teal-500" />
                            <div className="p-7">
                                <h2 className="text-xl font-bold text-slate-900 dark:text-white">{h.openDataTitle}</h2>
                                <p className={`mt-3 text-sm leading-relaxed ${bodyText}`}>{h.openDataText}</p>
                                <div className="mt-5 flex flex-wrap gap-x-6 gap-y-2 text-sm font-semibold">
                                    <Link to="/docs" className="text-emerald-700 hover:underline dark:text-emerald-400">{h.openDataApi}</Link>
                                    <a href={LINKS.dataLicense} target="_blank" rel="noopener noreferrer" className="text-emerald-700 hover:underline dark:text-emerald-400">
                                        {h.openDataLicense}
                                    </a>
                                </div>
                            </div>
                        </div>
                        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
                            <div className="h-1.5 bg-linear-to-r from-cyan-400 to-blue-500" />
                            <div className="p-7">
                                <h2 className="text-xl font-bold text-slate-900 dark:text-white">{h.openSourceTitle}</h2>
                                <p className={`mt-3 text-sm leading-relaxed ${bodyText}`}>{h.openSourceText}</p>
                                <div className="mt-5 flex flex-wrap gap-x-6 gap-y-2 text-sm font-semibold">
                                    {[
                                        [LINKS.repo, h.openSourceLinks.repo],
                                        [LINKS.buildFromSource, h.openSourceLinks.build],
                                        [LINKS.changelog, h.openSourceLinks.changelog],
                                        [LINKS.issues, h.openSourceLinks.issues],
                                    ].map(([href, label]) => (
                                        <a key={href} href={href} target="_blank" rel="noopener noreferrer" className="text-sky-700 hover:underline dark:text-sky-400">
                                            {label}
                                        </a>
                                    ))}
                                </div>
                            </div>
                        </div>
                    </div>
                </section>

                {/* Final call to action */}
                <section className="px-4 py-20 sm:px-6 lg:px-8">
                    <div className="relative mx-auto max-w-5xl overflow-hidden rounded-3xl bg-linear-to-r from-cyan-500 to-blue-600 px-6 py-14 text-center text-white shadow-xl md:px-12">
                        <div className="pointer-events-none absolute -top-24 -right-24 h-64 w-64 rounded-full bg-white/10" />
                        <div className="pointer-events-none absolute -bottom-28 -left-16 h-64 w-64 rounded-full bg-white/10" />
                        <h2 className="relative text-3xl font-bold text-balance md:text-4xl">{h.ctaTitle}</h2>
                        <p className="relative mx-auto mt-3 max-w-2xl text-lg text-balance text-white/90">{h.ctaText}</p>
                        <div className="relative mt-8 flex flex-col justify-center gap-3 sm:flex-row">
                            <Link
                                to="/map"
                                search={{ assetId: undefined }}
                                className="inline-flex items-center justify-center whitespace-nowrap rounded-full bg-white px-7 py-3 font-semibold text-blue-700 shadow hover:bg-sky-50 dark:bg-white dark:text-blue-700"
                            >
                                {h.bandMap}
                                <ArrowRight className="ml-2 h-4 w-4" />
                            </Link>
                            <Link
                                to="/docs"
                                className="inline-flex items-center justify-center whitespace-nowrap rounded-full border-2 border-white/80 px-7 py-3 font-semibold text-white hover:bg-white/10"
                            >
                                {h.bandApi}
                            </Link>
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
