// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import Header from "../components/Header";
import Footer from "../components/Footer";
import { Copy, Check, Database, ExternalLink, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { useI18n } from "../lib/i18n-context";
import type { Messages } from "../locales/vi";
import { LINKS } from "../lib/site";

/**
 * Public City API documentation.
 *
 * SynapseCity publishes a stable JSON open-data projection (not NGSI-LD) plus
 * anonymous citizen incident reporting. Operator/auth/admin endpoints are
 * intentionally not documented here.
 */
const API_BASE_URL = "https://synapsecity.sbs/v1";
const PUBLIC_API_BASE_URL = `${API_BASE_URL}/public`;

type EndpointKey = keyof Messages["docs"]["endpoints"];

interface PublicEndpoint {
  key: EndpointKey;
  path: string;
  query?: string;
  method?: "GET" | "POST";
}

const publicEndpoints: PublicEndpoint[] = [
  { key: "assets", path: "/assets", query: "limit, offset" },
  { key: "asset", path: "/assets/{code}" },
  { key: "qr", path: "/assets/{code}/qr-code" },
  { key: "maintenance", path: "/assets/{code}/maintenance-summary" },
  { key: "incidents", path: "/incidents", query: "limit, offset" },
  { key: "incident", path: "/incidents/{incidentId}" },
  { key: "report", path: "/incidents", method: "POST" },
];

const curlExamples = [
  { key: "assets" as const, command: `curl "${PUBLIC_API_BASE_URL}/assets?limit=50"` },
  { key: "incidents" as const, command: `curl "${PUBLIC_API_BASE_URL}/incidents?limit=50"` },
];

function EndpointCard({ endpoint }: { endpoint: PublicEndpoint }) {
  const { m } = useI18n();
  const [copied, setCopied] = useState(false);
  const info = m.docs.endpoints[endpoint.key];
  const method = endpoint.method || "GET";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${PUBLIC_API_BASE_URL}${endpoint.path}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be unavailable in non-secure contexts.
    }
  };

  return (
    <article className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={`rounded px-2 py-0.5 text-xs font-bold ${
                method === "POST"
                  ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                  : "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
              }`}
            >
              {method}
            </span>
            <code className="break-all font-mono text-sm text-slate-900 dark:text-slate-100">{endpoint.path}</code>
          </div>
          <h3 className="mt-2 font-semibold text-slate-800 dark:text-slate-100">{info.title}</h3>
          <p className="mt-1 text-sm leading-relaxed text-slate-600 dark:text-slate-400">{info.text}</p>
          {endpoint.query ? (
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              {m.docs.query}: <code className="font-mono">{endpoint.query}</code>
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={copy}
          title={m.docs.copy}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? m.docs.copied : m.docs.copy}
        </button>
      </div>
    </article>
  );
}

const ApiDocsPage = () => {
  const { m } = useI18n();
  const d = m.docs;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <Header />

      <main className="mx-auto max-w-5xl px-4 pb-16 pt-28 sm:px-6 lg:px-8">
        <section className="rounded-2xl border border-slate-200 bg-white p-6 md:p-8 dark:border-slate-800 dark:bg-slate-900">
          <div className="inline-flex items-center gap-2 rounded-full bg-emerald-100 px-3 py-1 text-sm font-medium text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
            <Database size={15} />
            {d.badge}
          </div>
          <h1 className="mt-4 text-3xl font-bold tracking-tight text-slate-900 md:text-4xl dark:text-white">{d.title}</h1>
          <p className="mt-3 max-w-3xl text-base leading-relaxed text-slate-600 dark:text-slate-300">{d.lead}</p>

          <div className="mt-5 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm dark:border-emerald-900 dark:bg-emerald-950/50">
            <p className="font-semibold text-emerald-900 dark:text-emerald-200">{d.baseUrl}</p>
            <code className="mt-1 block break-all font-mono text-emerald-800 dark:text-emerald-300">{PUBLIC_API_BASE_URL}</code>
          </div>
        </section>

        <section className="mt-8">
          <h2 className="text-xl font-semibold text-slate-900 dark:text-white">{d.endpointsTitle}</h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{d.endpointsLead}</p>
          <div className="mt-4 grid gap-4">
            {publicEndpoints.map((endpoint) => (
              <EndpointCard key={`${endpoint.method || "GET"} ${endpoint.path}`} endpoint={endpoint} />
            ))}
          </div>
        </section>

        <section className="mt-8 rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-white">{d.examplesTitle}</h2>
          <div className="mt-3 space-y-4">
            {curlExamples.map((example) => (
              <div key={example.key}>
                <p className="mb-1.5 text-sm font-medium text-slate-700 dark:text-slate-300">{d.examples[example.key]}</p>
                <pre className="overflow-x-auto rounded-lg bg-slate-900 p-4 text-xs leading-relaxed text-slate-100 dark:bg-black">
                  <code>{example.command}</code>
                </pre>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-8 grid gap-4 md:grid-cols-2">
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-5 dark:border-amber-900 dark:bg-amber-950/40">
            <div className="flex items-center gap-2 text-amber-800 dark:text-amber-300">
              <ShieldAlert size={18} />
              <h2 className="font-semibold">{d.internalTitle}</h2>
            </div>
            <p className="mt-2 text-sm leading-relaxed text-amber-900 dark:text-amber-200/90">{d.internalText}</p>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
            <h2 className="font-semibold text-slate-900 dark:text-white">{d.scopeTitle}</h2>
            <ul className="mt-2 space-y-1.5 text-sm text-slate-600 dark:text-slate-300">
              {d.scope.map((item) => (
                <li key={item}>{item}</li>
              ))}
              <li>
                {d.licenseLabel}{" "}
                <a
                  href={LINKS.dataLicense}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-teal-700 hover:underline dark:text-teal-400"
                >
                  CC0 1.0 Universal
                </a>
              </li>
            </ul>
            <a
              href={LINKS.repo}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-teal-700 hover:text-teal-800 dark:text-teal-400 dark:hover:text-teal-300"
            >
              {d.repoLink}
              <ExternalLink size={14} />
            </a>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
};

export default ApiDocsPage;
