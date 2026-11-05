// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { useState } from "react";
import { Check, Copy, Database, ExternalLink, ShieldAlert, Sparkles } from "lucide-react";
import Header from "../components/Header";
import Footer from "../components/Footer";
import { useI18n } from "../lib/i18n-context";
import type { Messages } from "../locales/vi";
import { LINKS } from "../lib/site";

/**
 * Public City API documentation.
 *
 * SynapseCity publishes a stable JSON open-data projection plus anonymous
 * citizen incident reporting. Operator/auth/admin endpoints are intentionally
 * not documented here.
 */
const PUBLIC_API_BASE_URL = "https://synapsecity.sbs/v1/public";

type EndpointKey = keyof Messages["docs"]["endpoints"];
type ParamKey = keyof Messages["docs"]["paramDocs"];

interface PublicEndpoint {
  key: EndpointKey;
  method: "GET" | "POST";
  path: string;
  params?: Array<{ name: string; doc: ParamKey; where: "path" | "query" }>;
  /** Example used for the curl line and the "open" link. */
  example: string;
  body?: string;
}

const ASSET_ENDPOINTS: PublicEndpoint[] = [
  { key: "assets", method: "GET", path: "/assets", params: [{ name: "limit", doc: "limit", where: "query" }, { name: "offset", doc: "offset", where: "query" }], example: "/assets?limit=10" },
  { key: "asset", method: "GET", path: "/assets/{code}", params: [{ name: "code", doc: "code", where: "path" }], example: "/assets/DN-LIGHT-0001" },
  { key: "qr", method: "GET", path: "/assets/{code}/qr-code", params: [{ name: "code", doc: "code", where: "path" }], example: "/assets/DN-LIGHT-0001/qr-code" },
  { key: "maintenance", method: "GET", path: "/assets/{code}/maintenance-summary", params: [{ name: "code", doc: "code", where: "path" }], example: "/assets/DN-LIGHT-0001/maintenance-summary" },
];

const INCIDENT_ENDPOINTS: PublicEndpoint[] = [
  { key: "incidents", method: "GET", path: "/incidents", params: [{ name: "limit", doc: "limit", where: "query" }, { name: "offset", doc: "offset", where: "query" }], example: "/incidents?limit=10" },
  { key: "incident", method: "GET", path: "/incidents/{incidentId}", params: [{ name: "incidentId", doc: "incidentId", where: "path" }], example: "/incidents/INC-2026-ABC123" },
  {
    key: "report",
    method: "POST",
    path: "/incidents",
    example: "/incidents",
    body: `{
  "title": "Đèn đường không sáng",
  "description": "Đèn trước số 12 Lê Duẩn tắt từ tối qua.",
  "category": "malfunction",
  "severity": "medium",
  "location": {
    "address": "12 Lê Duẩn, Hải Châu, Đà Nẵng",
    "geometry": { "type": "Point", "coordinates": [108.2208, 16.0717] }
  },
  "contact_info": { "name": "Nguyễn Văn A", "phone_number": "0905000000" }
}`,
  },
];

const QUICK_REQUEST = `curl "${PUBLIC_API_BASE_URL}/assets?limit=2"`;
const QUICK_RESPONSE = `[
  {
    "id": "a1f3…",
    "asset_code": "DN-LIGHT-0001",
    "name": "Đèn đường Lê Duẩn 01",
    "feature_type": "street_light",
    "category": "lighting",
    "status": "active",
    "location": {
      "address": "12 Lê Duẩn, Hải Châu, Đà Nẵng",
      "coordinates": { "longitude": 108.2208, "latitude": 16.0717 }
    },
    "public_url": "https://synapsecity.sbs/asset/DN-LIGHT-0001"
  }
]`;

function curlFor(e: PublicEndpoint): string {
  if (e.method === "GET") return `curl "${PUBLIC_API_BASE_URL}${e.example}"`;
  return `curl -X POST "${PUBLIC_API_BASE_URL}${e.example}" \\\n  -H "Content-Type: application/json" \\\n  -d @report.json`;
}

function CopyButton({ text, light = false }: { text: string; light?: boolean }) {
  const { m } = useI18n();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be unavailable in non-secure contexts.
    }
  };
  return (
    <button
      type="button"
      onClick={copy}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition ${
        light
          ? "border border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          : "bg-white/10 text-slate-200 hover:bg-white/20"
      }`}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
      {copied ? m.docs.copied : m.docs.copy}
    </button>
  );
}

function CodeBlock({ code, label }: { code: string; label?: string }) {
  return (
    <div className="overflow-hidden rounded-xl bg-slate-950 ring-1 ring-slate-800">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-2">
        <span className="text-xs font-medium text-slate-400">{label ?? "shell"}</span>
        <CopyButton text={code} />
      </div>
      <pre className="overflow-x-auto p-4 text-xs leading-relaxed text-slate-100">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function MethodBadge({ method }: { method: "GET" | "POST" }) {
  return (
    <span
      className={`rounded-md px-2 py-0.5 font-mono text-xs font-bold ${
        method === "POST"
          ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
          : "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
      }`}
    >
      {method}
    </span>
  );
}

function EndpointCard({ endpoint }: { endpoint: PublicEndpoint }) {
  const { m } = useI18n();
  const d = m.docs;
  const info = d.endpoints[endpoint.key];
  // Only list endpoints open usefully; path examples use made-up codes.
  const canOpen = endpoint.method === "GET" && !endpoint.params?.some((p) => p.where === "path");

  return (
    <article id={`ep-${endpoint.key}`} className="scroll-mt-28 rounded-2xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
      <div className="flex flex-wrap items-center gap-2">
        <MethodBadge method={endpoint.method} />
        <code className="font-mono text-sm font-semibold break-all text-slate-900 dark:text-slate-100">{endpoint.path}</code>
        <span className="ml-auto flex items-center gap-2">
          <CopyButton text={`${PUBLIC_API_BASE_URL}${endpoint.path}`} light />
          {canOpen && (
            <a
              href={`${PUBLIC_API_BASE_URL}${endpoint.example}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-md border border-sky-200 px-2.5 py-1 text-xs font-medium text-sky-700 hover:bg-sky-50 dark:border-sky-900 dark:text-sky-300 dark:hover:bg-sky-950"
            >
              {d.open} <ExternalLink size={12} />
            </a>
          )}
        </span>
      </div>
      <h3 className="mt-3 text-lg font-semibold text-slate-900 dark:text-white">{info.title}</h3>
      <p className="mt-1 text-sm leading-relaxed text-pretty text-slate-600 dark:text-slate-400">{info.text}</p>

      {endpoint.params && (
        <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800">
          <p className="bg-slate-50 px-4 py-2 text-xs font-semibold tracking-wide text-slate-500 uppercase dark:bg-slate-950 dark:text-slate-400">{d.params}</p>
          <dl className="divide-y divide-slate-200 dark:divide-slate-800">
            {endpoint.params.map((p) => (
              <div key={p.name} className="grid gap-1 px-4 py-2.5 text-sm sm:grid-cols-[10rem_1fr]">
                <dt className="font-mono text-slate-900 dark:text-slate-100">
                  {p.name} <span className="ml-1 font-sans text-xs text-slate-400">{p.where}</span>
                </dt>
                <dd className="text-slate-600 dark:text-slate-400">{d.paramDocs[p.doc]}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      <div className="mt-4 space-y-3">
        {endpoint.body && <CodeBlock code={endpoint.body} label={d.body} />}
        <CodeBlock code={curlFor(endpoint)} />
      </div>
    </article>
  );
}

const ApiDocsPage = () => {
  const { m } = useI18n();
  const d = m.docs;

  const toc = [
    { id: "quick-start", label: d.quickTitle },
    { id: "group-assets", label: d.groups.assets },
    { id: "group-incidents", label: d.groups.incidents },
    { id: "scope", label: d.scopeTitle },
  ];

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <Header />

      {/* Intro */}
      <section className="border-b border-sky-100 bg-linear-to-br from-sky-50 via-white to-cyan-50 pt-28 pb-12 dark:border-slate-800 dark:from-sky-950/40 dark:via-slate-950 dark:to-cyan-950/20">
        <div className="mx-auto max-w-6xl px-4 text-center sm:px-6 lg:px-8">
          <span className="inline-flex items-center gap-2 rounded-full bg-sky-100 px-3 py-1 text-sm font-semibold text-sky-700 dark:bg-sky-950 dark:text-sky-300">
            <Database size={15} />
            {d.badge}
          </span>
          <h1 className="mt-4 text-3xl font-bold text-balance text-slate-900 md:text-5xl dark:text-white">
            SynapseCity <span className="bg-linear-to-r from-sky-500 to-cyan-400 bg-clip-text text-transparent">Open API</span>
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-balance text-slate-600 dark:text-slate-300">{d.lead}</p>
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            {d.highlights.map((h) => (
              <span key={h} className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1 text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
                <Sparkles className="h-3.5 w-3.5 text-sky-500" />
                {h}
              </span>
            ))}
          </div>
          <div className="mx-auto mt-8 flex max-w-xl items-center gap-3 rounded-2xl border border-slate-200 bg-white p-2 pl-4 text-left shadow-sm dark:border-slate-700 dark:bg-slate-900">
            <span className="text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">{d.baseUrl}</span>
            <code className="min-w-0 flex-1 truncate font-mono text-sm text-slate-900 dark:text-slate-100">{PUBLIC_API_BASE_URL}</code>
            <CopyButton text={PUBLIC_API_BASE_URL} light />
          </div>
        </div>
      </section>

      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-12 sm:px-6 lg:grid-cols-[13rem_1fr] lg:px-8">
        {/* Table of contents */}
        <nav className="hidden lg:block">
          <div className="sticky top-28">
            <p className="text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">{d.toc}</p>
            <ul className="mt-3 space-y-1 border-l border-slate-200 dark:border-slate-800">
              {toc.map((t) => (
                <li key={t.id}>
                  <a href={`#${t.id}`} className="-ml-px block border-l-2 border-transparent py-1.5 pl-4 text-sm text-slate-600 hover:border-sky-500 hover:text-sky-700 dark:text-slate-400 dark:hover:text-sky-300">
                    {t.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </nav>

        <main className="min-w-0 space-y-14">
          {/* Quick start */}
          <section id="quick-start" className="scroll-mt-28">
            <h2 className="text-2xl font-bold text-slate-900 dark:text-white">{d.quickTitle}</h2>
            <p className="mt-2 text-pretty text-slate-600 dark:text-slate-300">{d.quickText}</p>
            <div className="mt-5 space-y-4">
              <CodeBlock code={QUICK_REQUEST} label={d.quickRequest} />
              <CodeBlock code={QUICK_RESPONSE} label={d.quickResponse} />
            </div>
            <p className="mt-3 text-sm text-pretty text-slate-500 dark:text-slate-400">{d.quickPaging}</p>
          </section>

          <section id="group-assets" className="scroll-mt-28">
            <h2 className="text-2xl font-bold text-slate-900 dark:text-white">{d.groups.assets}</h2>
            <div className="mt-5 space-y-5">
              {ASSET_ENDPOINTS.map((e) => (
                <EndpointCard key={e.key} endpoint={e} />
              ))}
            </div>
          </section>

          <section id="group-incidents" className="scroll-mt-28">
            <h2 className="text-2xl font-bold text-slate-900 dark:text-white">{d.groups.incidents}</h2>
            <div className="mt-5 space-y-5">
              {INCIDENT_ENDPOINTS.map((e) => (
                <EndpointCard key={e.key} endpoint={e} />
              ))}
            </div>
          </section>

          <section id="scope" className="grid scroll-mt-28 gap-4 md:grid-cols-2">
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 dark:border-amber-900 dark:bg-amber-950/40">
              <div className="flex items-center gap-2 text-amber-800 dark:text-amber-300">
                <ShieldAlert size={18} />
                <h2 className="font-semibold">{d.internalTitle}</h2>
              </div>
              <p className="mt-2 text-sm leading-relaxed text-pretty text-amber-900 dark:text-amber-200/90">{d.internalText}</p>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
              <h2 className="font-semibold text-slate-900 dark:text-white">{d.scopeTitle}</h2>
              <ul className="mt-3 space-y-2 text-sm text-slate-600 dark:text-slate-300">
                {d.scope.map((item) => (
                  <li key={item} className="flex gap-2">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                    {item}
                  </li>
                ))}
                <li className="flex gap-2">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                  <span>
                    {d.licenseLabel}{" "}
                    <a href={LINKS.dataLicense} target="_blank" rel="noopener noreferrer" className="font-medium text-sky-700 hover:underline dark:text-sky-400">
                      PDDL 1.0
                    </a>
                  </span>
                </li>
              </ul>
              <a href={LINKS.repo} target="_blank" rel="noopener noreferrer" className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-sky-700 hover:underline dark:text-sky-400">
                {d.repoLink}
                <ExternalLink size={14} />
              </a>
            </div>
          </section>
        </main>
      </div>

      <Footer />
    </div>
  );
};

export default ApiDocsPage;
