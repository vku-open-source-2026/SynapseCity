// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useState } from "react";
import { Link } from "@tanstack/react-router";
import { CheckCircle2, ExternalLink, Layers } from "lucide-react";
import Header from "../components/Header";
import Footer from "../components/Footer";
import { useI18n } from "../lib/i18n-context";
import { LINKS } from "../lib/site";

interface TeamMember {
    name: string;
    avatar?: string;
}

// Same order as the original About page.
const teamMembers: TeamMember[] = [
    { name: "Hồ Sỹ Bảo Nhân", avatar: "/avatars/nhan.jpg" },
    { name: "Võ Thành Nam" },
    { name: "Trần Thị Thùy Dương", avatar: "/avatars/duong.jpg" },
];

const TIER_STYLES = [
    { href: null, ring: "border-sky-300 bg-sky-50/60 dark:border-sky-800 dark:bg-sky-950/40", dot: "from-cyan-400 to-blue-500" },
    { href: LINKS.synapseDX, ring: "border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900", dot: "from-violet-400 to-indigo-500" },
    { href: LINKS.synapseOne, ring: "border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900", dot: "from-slate-500 to-slate-700" },
];

const sectionTitle = "text-3xl font-bold text-slate-900 dark:text-white";
const sectionLead = "mx-auto mt-3 max-w-2xl text-slate-600 dark:text-slate-300";
const body = "text-slate-600 dark:text-slate-300";

function Avatar({ member }: { member: TeamMember }) {
    const [failed, setFailed] = useState(false);
    const initial = member.name.split(" ").pop()?.charAt(0) ?? "?";
    if (member.avatar && !failed) {
        return (
            <img
                src={member.avatar}
                alt={member.name}
                onError={() => setFailed(true)}
                className="h-24 w-24 rounded-full object-cover ring-4 ring-sky-100 dark:ring-sky-900"
            />
        );
    }
    return (
        <span className="flex h-24 w-24 items-center justify-center rounded-full bg-linear-to-br from-sky-100 to-cyan-200 text-3xl font-semibold text-sky-700 ring-4 ring-sky-100 dark:from-sky-900 dark:to-cyan-900 dark:text-sky-200 dark:ring-sky-900">
            {initial}
        </span>
    );
}

const AboutUs: React.FC = () => {
    const { m } = useI18n();
    const a = m.about;
    const l = a.license;

    const licenseRows: Array<{ label: string; value: string; href: string }> = [
        { ...l.source, href: LINKS.sourceLicense },
        { ...l.data, href: LINKS.dataLicense },
        { ...l.thirdParty, href: LINKS.thirdParty },
        { ...l.basemap, href: LINKS.basemap },
        { ...l.build, href: LINKS.buildFromSource },
        { ...l.releases, href: LINKS.releases },
        { ...l.changelog, href: LINKS.changelog },
        { ...l.issues, href: LINKS.issues },
        { ...l.contributing, href: LINKS.contributing },
    ];

    return (
        <div className="min-h-screen bg-white text-slate-900 dark:bg-slate-950 dark:text-slate-100">
            <Header />

            {/* Hero */}
            <section className="relative overflow-hidden px-4 pt-36 pb-16 text-center sm:px-6">
                <div className="pointer-events-none absolute top-10 left-1/2 h-72 w-[40rem] -translate-x-1/2 rounded-full bg-cyan-200/40 blur-3xl dark:bg-cyan-500/10" />
                <h1 className="relative text-4xl font-bold text-slate-900 md:text-5xl dark:text-white">
                    {a.titleStart}{" "}
                    <span className="bg-linear-to-r from-sky-500 to-cyan-400 bg-clip-text text-transparent">SynapseCity</span>
                </h1>
                <p className="relative mx-auto mt-4 max-w-2xl text-lg text-slate-600 dark:text-slate-300">{a.subtitle}</p>
            </section>

            {/* Mission */}
            <section className="px-4 py-8 sm:px-6">
                <div className="mx-auto max-w-3xl rounded-3xl border border-sky-100 bg-linear-to-br from-sky-50 to-cyan-50 p-8 text-center md:p-12 dark:border-sky-900 dark:from-sky-950/50 dark:to-cyan-950/30">
                    <h2 className="text-2xl font-bold text-slate-900 dark:text-white">{a.missionTitle}</h2>
                    <div className={`mt-4 space-y-4 text-lg leading-relaxed ${body}`}>
                        {a.mission.map((p) => (
                            <p key={p}>{p}</p>
                        ))}
                    </div>
                </div>
            </section>

            {/* Features */}
            <section className="px-4 py-16 sm:px-6">
                <div className="mx-auto max-w-4xl text-center">
                    <h2 className={sectionTitle}>{a.featuresTitle}</h2>
                    <div className="mt-8 grid gap-4 text-left sm:grid-cols-2 lg:grid-cols-3">
                        {a.features.map((f) => (
                            <div
                                key={f}
                                className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"
                            >
                                <CheckCircle2 className="h-5 w-5 shrink-0 text-sky-500" />
                                <span className="font-medium text-slate-700 dark:text-slate-200">{f}</span>
                            </div>
                        ))}
                    </div>
                </div>
            </section>

            {/* Platform */}
            <section className="bg-slate-50 px-4 py-16 sm:px-6 dark:bg-slate-900/50">
                <div className="mx-auto max-w-4xl">
                    <div className="text-center">
                        <h2 className={sectionTitle}>{a.platformTitle}</h2>
                        <p className={sectionLead}>{a.platformLead}</p>
                    </div>
                    <div className="mt-10 space-y-3">
                        {a.tiers.map((t, i) => {
                            const style = TIER_STYLES[i];
                            return (
                                <div key={t.name} className={`flex flex-col gap-3 rounded-2xl border p-5 sm:flex-row sm:items-center sm:gap-6 ${style.ring}`}>
                                    <div className="flex items-center gap-3 sm:w-64 sm:shrink-0">
                                        <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-linear-to-br ${style.dot} text-white`}>
                                            <Layers className="h-5 w-5" />
                                        </span>
                                        <div>
                                            {style.href ? (
                                                <a href={style.href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-semibold text-slate-900 hover:text-sky-600 dark:text-white dark:hover:text-sky-400">
                                                    {t.name} <ExternalLink className="h-3.5 w-3.5" />
                                                </a>
                                            ) : (
                                                <p className="font-semibold text-sky-700 dark:text-sky-300">{t.name}</p>
                                            )}
                                            <p className="text-xs font-medium text-slate-500 dark:text-slate-400">{t.level}</p>
                                        </div>
                                    </div>
                                    <p className={`text-sm ${body}`}>{t.text}</p>
                                </div>
                            );
                        })}
                    </div>
                    <p className="mt-4 text-center text-sm text-slate-500 dark:text-slate-400">{a.tiersNote}</p>
                </div>
            </section>

            {/* Team */}
            <section className="px-4 py-16 sm:px-6">
                <div className="mx-auto max-w-4xl text-center">
                    <h2 className={sectionTitle}>{a.teamTitle}</h2>
                    <p className={sectionLead}>{a.teamLead}</p>
                    <div className="mt-10 grid gap-6 sm:grid-cols-3">
                        {teamMembers.map((member) => (
                            <div
                                key={member.name}
                                className="flex flex-col items-center rounded-2xl border border-slate-200 bg-white p-7 transition hover:-translate-y-1 hover:shadow-lg dark:border-slate-800 dark:bg-slate-900"
                            >
                                <Avatar member={member} />
                                <h3 className="mt-4 font-semibold text-slate-900 dark:text-white">{member.name}</h3>
                            </div>
                        ))}
                    </div>
                </div>
            </section>

            {/* Partners */}
            <section className="bg-slate-50 px-4 py-16 sm:px-6 dark:bg-slate-900/50">
                <div className="mx-auto max-w-4xl text-center">
                    <h2 className={sectionTitle}>{a.partnersTitle}</h2>
                    <p className={sectionLead}>{a.partnersLead}</p>
                    <div className="mt-8 flex flex-wrap justify-center gap-4">
                        {[
                            { href: LINKS.vku, logo: "/vku-logo.svg", label: a.partners.vku },
                            { href: LINKS.vic, logo: "/vic-logo.svg", label: a.partners.vic },
                        ].map((p) => (
                            <a
                                key={p.href}
                                href={p.href}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center gap-4 rounded-2xl border border-slate-200 bg-white px-6 py-4 transition hover:border-sky-300 hover:shadow-md dark:border-slate-800 dark:bg-slate-900 dark:hover:border-sky-800"
                            >
                                <span className="flex h-12 w-12 items-center justify-center rounded-lg bg-white p-1.5 dark:bg-white">
                                    <img src={p.logo} alt="" className="max-h-full max-w-full object-contain" />
                                </span>
                                <span className="font-semibold text-slate-800 dark:text-slate-100">{p.label}</span>
                            </a>
                        ))}
                    </div>
                </div>
            </section>

            {/* Licences and source */}
            <section id="license" className="scroll-mt-28 px-4 py-16 sm:px-6">
                <div className="mx-auto max-w-4xl">
                    <div className="text-center">
                        <h2 className={sectionTitle}>{a.licenseTitle}</h2>
                        <p className={sectionLead}>{a.licenseLead}</p>
                    </div>
                    <dl className="mt-8 divide-y divide-slate-200 overflow-hidden rounded-2xl border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
                        {licenseRows.map((row) => (
                            <div key={row.label} className="grid gap-1 bg-white px-5 py-3.5 sm:grid-cols-[13rem_1fr] sm:gap-6 dark:bg-slate-900">
                                <dt className="text-sm font-semibold text-slate-900 dark:text-slate-100">{row.label}</dt>
                                <dd>
                                    <a href={row.href} target="_blank" rel="noopener noreferrer" className="text-sm text-sky-700 hover:underline dark:text-sky-400">
                                        {row.value}
                                    </a>
                                </dd>
                            </div>
                        ))}
                    </dl>
                </div>
            </section>

            {/* Contribute */}
            <section className="px-4 pb-20 sm:px-6">
                <div className="relative mx-auto max-w-4xl overflow-hidden rounded-3xl bg-linear-to-r from-cyan-500 to-blue-600 px-6 py-12 text-center text-white shadow-xl">
                    <div className="pointer-events-none absolute -top-20 -right-20 h-56 w-56 rounded-full bg-white/10" />
                    <h2 className="relative text-2xl font-bold md:text-3xl">{a.contributeTitle}</h2>
                    <p className="relative mx-auto mt-3 max-w-xl text-lg text-white/90">{a.contributeText}</p>
                    <div className="relative mt-7 flex flex-wrap justify-center gap-3">
                        <a
                            href={LINKS.repo}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center rounded-full bg-white px-6 py-2.5 font-semibold text-blue-700 hover:bg-sky-50 dark:bg-white dark:text-blue-700"
                        >
                            {a.contributeRepo}
                        </a>
                        <a
                            href={LINKS.dataContribution}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center rounded-full border-2 border-white/80 px-6 py-2.5 font-semibold text-white hover:bg-white/10"
                        >
                            {a.contributeData}
                        </a>
                        <Link
                            to="/docs"
                            className="inline-flex items-center rounded-full border-2 border-white/80 px-6 py-2.5 font-semibold text-white hover:bg-white/10"
                        >
                            {m.nav.docs}
                        </Link>
                    </div>
                </div>
            </section>

            <Footer />
        </div>
    );
};

export default AboutUs;
