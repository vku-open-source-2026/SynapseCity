// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Activity, ClipboardList, Code2, Gauge, Map as MapIcon, Wrench } from "lucide-react";
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

/** One accent per feature card, in the same order as `about.features`. */
const FEATURE_STYLES = [
    { icon: MapIcon, tile: "from-cyan-400 to-blue-500", hover: "hover:border-sky-300 dark:hover:border-sky-700" },
    { icon: Activity, tile: "from-emerald-400 to-teal-500", hover: "hover:border-emerald-300 dark:hover:border-emerald-700" },
    { icon: Wrench, tile: "from-amber-400 to-orange-500", hover: "hover:border-amber-300 dark:hover:border-amber-700" },
    { icon: Code2, tile: "from-violet-400 to-indigo-500", hover: "hover:border-violet-300 dark:hover:border-violet-700" },
    { icon: ClipboardList, tile: "from-rose-400 to-pink-500", hover: "hover:border-rose-300 dark:hover:border-rose-700" },
    { icon: Gauge, tile: "from-sky-400 to-cyan-500", hover: "hover:border-cyan-300 dark:hover:border-cyan-700" },
];

const sectionTitle = "text-3xl font-bold text-balance text-slate-900 dark:text-white";
const sectionLead = "mx-auto mt-3 max-w-2xl text-balance text-slate-600 dark:text-slate-300";
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
                <div className="pointer-events-none absolute top-10 left-1/2 h-72 w-[40rem] max-w-full -translate-x-1/2 rounded-full bg-cyan-200/40 blur-3xl dark:bg-cyan-500/10" />
                <h1 className="relative text-4xl font-bold text-balance text-slate-900 md:text-5xl dark:text-white">
                    {a.titleStart}{" "}
                    <span className="bg-linear-to-r from-sky-500 to-cyan-400 bg-clip-text text-transparent">SynapseCity</span>
                </h1>
                <p className="relative mx-auto mt-4 max-w-2xl text-lg text-balance text-slate-600 dark:text-slate-300">{a.subtitle}</p>
            </section>

            {/* Mission */}
            <section className="px-4 py-8 sm:px-6">
                <div className="mx-auto max-w-3xl rounded-3xl border border-sky-100 bg-linear-to-br from-sky-50 to-cyan-50 p-8 text-center md:p-12 dark:border-sky-900 dark:from-sky-950/50 dark:to-cyan-950/30">
                    <h2 className="text-2xl font-bold text-balance text-slate-900 dark:text-white">{a.missionTitle}</h2>
                    <div className={`mt-4 space-y-4 text-lg leading-relaxed text-balance ${body}`}>
                        {a.mission.map((p) => (
                            <p key={p}>{p}</p>
                        ))}
                    </div>
                </div>
            </section>

            {/* Features */}
            <section className="px-4 py-16 sm:px-6">
                <div className="mx-auto max-w-5xl">
                    <h2 className={`${sectionTitle} text-center`}>{a.featuresTitle}</h2>
                    <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                        {a.features.map((f, i) => {
                            const style = FEATURE_STYLES[i % FEATURE_STYLES.length];
                            const Icon = style.icon;
                            return (
                                <div
                                    key={f.title}
                                    className={`group relative overflow-hidden rounded-2xl border border-slate-200 bg-white p-6 transition duration-300 hover:-translate-y-1 hover:shadow-xl dark:border-slate-800 dark:bg-slate-900 ${style.hover}`}
                                >
                                    <span className="pointer-events-none absolute -top-3 right-4 font-mono text-6xl font-bold text-slate-100 transition group-hover:text-slate-200 dark:text-slate-800 dark:group-hover:text-slate-700">
                                        {String(i + 1).padStart(2, "0")}
                                    </span>
                                    <span className={`relative flex h-12 w-12 items-center justify-center rounded-xl bg-linear-to-br ${style.tile} text-white shadow-md transition group-hover:scale-110`}>
                                        <Icon className="h-6 w-6" />
                                    </span>
                                    <h3 className="relative mt-5 text-lg font-semibold text-balance text-slate-900 dark:text-white">{f.title}</h3>
                                    <p className={`relative mt-2 text-sm leading-relaxed text-pretty ${body}`}>{f.text}</p>
                                </div>
                            );
                        })}
                    </div>
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
                            className="inline-flex items-center whitespace-nowrap rounded-full bg-white px-6 py-2.5 font-semibold text-blue-700 hover:bg-sky-50 dark:bg-white dark:text-blue-700"
                        >
                            {a.contributeRepo}
                        </a>
                        <a
                            href={LINKS.dataContribution}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center whitespace-nowrap rounded-full border-2 border-white/80 px-6 py-2.5 font-semibold text-white hover:bg-white/10"
                        >
                            {a.contributeData}
                        </a>
                        <Link
                            to="/docs"
                            className="inline-flex items-center whitespace-nowrap rounded-full border-2 border-white/80 px-6 py-2.5 font-semibold text-white hover:bg-white/10"
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
