// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useState } from "react";
import { Link } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";
import Header from "../components/Header";
import Footer from "../components/Footer";
import { useI18n } from "../lib/i18n-context";
import { LINKS } from "../lib/site";

interface TeamMember {
    name: string;
    avatar?: string;
}

const teamMembers: TeamMember[] = [
    { name: "Hồ Sỹ Bảo Nhân", avatar: "/avatars/nhan.jpg" },
    { name: "Trần Thị Thùy Dương" },
    { name: "Võ Thành Nam" },
];

const TIER_LINKS: Array<string | null> = [null, LINKS.synapseDX, LINKS.synapseOne];

const card = "rounded-2xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900";
const h2 = "text-2xl font-bold text-slate-900 dark:text-white";
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
                className="h-20 w-20 rounded-full object-cover"
            />
        );
    }
    return (
        <span className="flex h-20 w-20 items-center justify-center rounded-full bg-teal-50 text-2xl font-semibold text-teal-700 dark:bg-teal-950 dark:text-teal-400">
            {initial}
        </span>
    );
}

const AboutUs: React.FC = () => {
    const { m } = useI18n();
    const a = m.about;
    const c = a.compliance;

    const complianceRows: Array<{ label: string; value: string; href: string }> = [
        { ...c.source, href: LINKS.sourceLicense },
        { ...c.data, href: LINKS.dataLicense },
        { ...c.thirdParty, href: LINKS.thirdParty },
        { ...c.basemap, href: LINKS.osmCopyright },
        { ...c.build, href: LINKS.buildFromSource },
        { ...c.releases, href: LINKS.releases },
        { ...c.changelog, href: LINKS.changelog },
        { ...c.issues, href: LINKS.issues },
        { ...c.contributing, href: LINKS.contributing },
        { ...c.demo, href: LINKS.demo },
    ];

    return (
        <div className="min-h-screen bg-white text-slate-900 dark:bg-slate-950 dark:text-slate-100">
            <Header />
            <main className="mx-auto max-w-5xl px-4 pt-32 pb-20 sm:px-6 lg:px-8">
                {/* Intro */}
                <p className="text-sm font-semibold text-teal-700 dark:text-teal-400">{a.kicker}</p>
                <h1 className="mt-2 text-3xl font-bold text-slate-900 md:text-4xl dark:text-white">{a.title}</h1>
                <p className={`mt-4 max-w-3xl text-lg leading-relaxed ${body}`}>{a.lead}</p>

                {/* Story */}
                <section className="mt-14">
                    <h2 className={h2}>{a.storyTitle}</h2>
                    <div className={`mt-4 max-w-3xl space-y-4 leading-relaxed ${body}`}>
                        {a.story.map((p) => (
                            <p key={p}>{p}</p>
                        ))}
                    </div>
                </section>

                {/* Tiers */}
                <section className="mt-14">
                    <h2 className={h2}>{a.tiersTitle}</h2>
                    <div className="mt-6 space-y-3">
                        {a.tiers.map((t, i) => {
                            const href = TIER_LINKS[i];
                            return (
                                <div
                                    key={t.name}
                                    className={`${card} flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-6 ${i === 0 ? "border-teal-300 dark:border-teal-800" : ""}`}
                                >
                                    <div className="sm:w-56 sm:shrink-0">
                                        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{t.level}</p>
                                        {href ? (
                                            <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-semibold text-slate-900 hover:text-teal-700 dark:text-white dark:hover:text-teal-400">
                                                {t.name} <ExternalLink className="h-3.5 w-3.5" />
                                            </a>
                                        ) : (
                                            <p className="font-semibold text-teal-700 dark:text-teal-400">{t.name}</p>
                                        )}
                                    </div>
                                    <p className={`text-sm ${body}`}>{t.text}</p>
                                </div>
                            );
                        })}
                    </div>
                    <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">{a.tiersNote}</p>
                </section>

                {/* Team */}
                <section className="mt-14">
                    <h2 className={h2}>{a.teamTitle}</h2>
                    <p className={`mt-1 ${body}`}>{a.teamLead}</p>
                    <div className="mt-6 grid gap-6 sm:grid-cols-3">
                        {teamMembers.map((member) => (
                            <div key={member.name} className={`${card} flex flex-col items-center text-center`}>
                                <Avatar member={member} />
                                <h3 className="mt-4 font-semibold text-slate-900 dark:text-white">{member.name}</h3>
                            </div>
                        ))}
                    </div>
                </section>

                {/* Partners */}
                <section className="mt-14">
                    <h2 className={h2}>{a.partnersTitle}</h2>
                    <div className="mt-6 flex flex-wrap gap-4">
                        {[
                            { href: LINKS.vku, logo: "/vku-logo.svg", label: a.partners.vku },
                            { href: LINKS.vic, logo: "/vic-logo.svg", label: a.partners.vic },
                        ].map((p) => (
                            <a
                                key={p.href}
                                href={p.href}
                                target="_blank"
                                rel="noopener noreferrer"
                                className={`${card} flex items-center gap-4 py-4 hover:border-teal-300 dark:hover:border-teal-800`}
                            >
                                <span className="flex h-12 w-12 items-center justify-center rounded-lg bg-white p-1.5 dark:bg-white">
                                    <img src={p.logo} alt="" className="max-h-full max-w-full object-contain" />
                                </span>
                                <span className="font-medium text-slate-800 dark:text-slate-100">{p.label}</span>
                            </a>
                        ))}
                    </div>
                </section>

                {/* Licences and OLP project documents */}
                <section id="license" className="mt-14 scroll-mt-28">
                    <h2 className={h2}>{a.complianceTitle}</h2>
                    <p className={`mt-1 ${body}`}>{a.complianceLead}</p>
                    <dl className="mt-6 divide-y divide-slate-200 overflow-hidden rounded-2xl border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
                        {complianceRows.map((row) => (
                            <div key={row.label} className="grid gap-1 bg-white px-5 py-3.5 sm:grid-cols-[14rem_1fr] sm:gap-6 dark:bg-slate-900">
                                <dt className="text-sm font-medium text-slate-900 dark:text-slate-100">{row.label}</dt>
                                <dd>
                                    <a href={row.href} target="_blank" rel="noopener noreferrer" className="text-sm text-teal-700 hover:underline dark:text-teal-400">
                                        {row.value}
                                    </a>
                                </dd>
                            </div>
                        ))}
                    </dl>
                </section>

                {/* Contribute */}
                <section className={`${card} mt-14`}>
                    <h2 className="text-xl font-bold text-slate-900 dark:text-white">{a.contributeTitle}</h2>
                    <p className={`mt-2 max-w-2xl text-sm leading-relaxed ${body}`}>{a.contributeText}</p>
                    <div className="mt-5 flex flex-wrap gap-3">
                        <a
                            href={LINKS.repo}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center rounded-lg bg-teal-700 px-5 py-2.5 text-sm font-semibold text-white hover:bg-teal-800 dark:bg-teal-500 dark:text-slate-950 dark:hover:bg-teal-400"
                        >
                            {a.contributeRepo}
                        </a>
                        <a
                            href={LINKS.dataContribution}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center rounded-lg border border-slate-300 px-5 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                        >
                            {a.contributeData}
                        </a>
                        <Link
                            to="/docs"
                            className="inline-flex items-center rounded-lg border border-slate-300 px-5 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                        >
                            {m.nav.docs}
                        </Link>
                    </div>
                </section>
            </main>
            <Footer />
        </div>
    );
};

export default AboutUs;
