// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { ExternalLink, MapPinned, ShieldCheck } from "lucide-react";
import { WORKSPACE_URL } from "../lib/workspace";

/**
 * Fallback notice for a retired Tier-3 work surface.
 *
 * The root route and nginx redirect these paths to the Tier-2 workspace before
 * this component renders. It stays dependency-light and public so a visitor
 * with JavaScript disabled (or an intercepted redirect) still gets a working
 * HTTPS link and the public City pages.
 */
export function WorkspaceMovedNotice() {
    return (
        <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-16 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
            <section className="w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-8 shadow-sm dark:border-slate-800 dark:bg-slate-900">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-600 dark:text-sky-400">
                    SynapseCity
                </p>
                <h1 className="mt-2 font-montserrat text-2xl font-bold">Workspace moved</h1>
                <p className="mt-3 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
                    Login, registration and every operations or technician dashboard now live in
                    the shared SynapseDX workspace. This public site keeps the asset map, public
                    reports and citizen intake.
                </p>
                <a
                    href={WORKSPACE_URL}
                    rel="noopener"
                    className="mt-6 inline-flex items-center gap-2 rounded-xl bg-sky-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-sky-700"
                >
                    Open SynapseDX workspace
                    <ExternalLink className="h-4 w-4" aria-hidden="true" />
                </a>
                <div className="mt-6 flex flex-wrap gap-3 text-sm">
                    <a
                        href="/map"
                        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                    >
                        <MapPinned className="h-4 w-4" aria-hidden="true" />
                        Public asset map
                    </a>
                    <a
                        href="/public/report"
                        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                    >
                        <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                        Report an issue
                    </a>
                </div>
            </section>
        </main>
    );
}
