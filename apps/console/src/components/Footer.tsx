// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useI18n } from "../lib/i18n-context";
import { LINKS } from "../lib/site";

const linkClass =
    "text-sm text-slate-600 hover:text-sky-600 hover:underline dark:text-slate-400 dark:hover:text-sky-400";

function Ext({ href, children }: { href: string; children: ReactNode }) {
    return (
        <a href={href} target="_blank" rel="noopener noreferrer" className={linkClass}>
            {children}
        </a>
    );
}

function Column({ title, children }: { title: string; children: ReactNode }) {
    return (
        <div>
            <p className="mb-3 text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</p>
            <div className="flex flex-col gap-2">{children}</div>
        </div>
    );
}

/**
 * Site footer. Besides navigation it links to the source, releases, changelog,
 * build guide, bug tracker, contribution guide and the code / data / third-party
 * licences.
 */
const Footer = () => {
    const { m } = useI18n();
    const l = m.footer.links;

    return (
        <footer className="border-t border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950">
            <div className="mx-auto grid max-w-7xl gap-10 px-4 py-12 sm:px-6 md:grid-cols-[1.4fr_repeat(4,1fr)] lg:px-8">
                <div>
                    <p className="font-montserrat text-lg font-bold text-[#1D4ED8] dark:text-blue-300">SynapseCity</p>
                    <p className="mt-2 max-w-xs text-sm text-slate-600 dark:text-slate-400">{m.footer.tagline}</p>
                </div>

                <Column title={m.footer.product}>
                    <Link to="/map" search={{ assetId: undefined }} className={linkClass}>{l.map}</Link>
                    <Link to="/public/report" className={linkClass}>{l.report}</Link>
                    <Link to="/docs" className={linkClass}>{l.docs}</Link>
                    <a href={LINKS.sos} className={linkClass}>{l.sos}</a>
                </Column>

                <Column title={m.footer.project}>
                    <Link to="/about" className={linkClass}>{l.about}</Link>
                    <Ext href={LINKS.repo}>{l.repo}</Ext>
                    <Ext href={LINKS.releases}>{l.releases}</Ext>
                    <Ext href={LINKS.changelog}>{l.changelog}</Ext>
                </Column>

                <Column title={m.footer.support}>
                    <Ext href={LINKS.buildFromSource}>{l.build}</Ext>
                    <Ext href={LINKS.issues}>{l.issues}</Ext>
                    <Ext href={LINKS.contributing}>{l.contributing}</Ext>
                    <Ext href={LINKS.dataContribution}>{l.data}</Ext>
                </Column>

                <Column title={m.footer.licenses}>
                    <Ext href={LINKS.sourceLicense}>{l.source}</Ext>
                    <Ext href={LINKS.dataLicense}>{l.dataLicense}</Ext>
                    <Ext href={LINKS.thirdParty}>{l.thirdParty}</Ext>
                </Column>
            </div>
            <div className="border-t border-slate-200 dark:border-slate-800">
                <p className="mx-auto max-w-7xl px-4 py-5 text-xs text-slate-500 sm:px-6 lg:px-8 dark:text-slate-500">
                    {m.footer.bottom}
                </p>
            </div>
        </footer>
    );
};

export default Footer;
