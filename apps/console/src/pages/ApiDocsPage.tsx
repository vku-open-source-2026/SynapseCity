// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import Header from "../components/Header";
import Footer from "../components/Footer";
import { Copy, Check, Database, ExternalLink, ShieldAlert } from "lucide-react";
import { useState } from "react";

/**
 * Public City API documentation.
 *
 * SynapseCity only publishes the read-only NGSI-LD open-data projection.
 * Operator/auth/admin endpoints are intentionally not documented here.
 */
const API_BASE_URL = "https://synapsecity.sbs/v1";
const PUBLIC_API_BASE_URL = `${API_BASE_URL}/public`;

interface PublicEndpoint {
  path: string;
  title: string;
  description: string;
  query?: string;
}

const publicEndpoints: PublicEndpoint[] = [
  {
    path: "/assets",
    title: "Danh sách tài sản công khai",
    description:
      "Projection NGSI-LD chỉ đọc của city-assets. Không trả về dữ liệu vận hành nội bộ.",
    query: "limit, offset",
  },
  {
    path: "/incidents",
    title: "Danh sách sự cố công khai",
    description:
      "Projection NGSI-LD chỉ đọc của city-incidents. Chỉ các bản ghi public_visible được trả về; không có thông tin liên hệ người báo.",
    query: "limit, offset",
  },
];

const curlExamples = [
  {
    label: "Tài sản công khai",
    command: `curl "${PUBLIC_API_BASE_URL}/assets?limit=50"`,
  },
  {
    label: "Sự cố công khai",
    command: `curl "${PUBLIC_API_BASE_URL}/incidents?limit=50"`,
  },
];

function EndpointCard({ endpoint }: { endpoint: PublicEndpoint }) {
  const [copied, setCopied] = useState(false);

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
    <article className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs font-bold text-emerald-700">
              GET
            </span>
            <code className="break-all font-mono text-sm text-slate-900">
              {endpoint.path}
            </code>
          </div>
          <h3 className="mt-2 font-semibold text-slate-800">{endpoint.title}</h3>
          <p className="mt-1 text-sm leading-relaxed text-slate-500">
            {endpoint.description}
          </p>
          {endpoint.query ? (
            <p className="mt-2 text-xs text-slate-500">
              Query: <code className="font-mono">{endpoint.query}</code>
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={copy}
          title="Copy endpoint URL"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? "Đã copy" : "Copy URL"}
        </button>
      </div>
    </article>
  );
}

const ApiDocsPage = () => {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <Header />

      <main className="mx-auto max-w-5xl px-4 pb-16 pt-28 sm:px-6 lg:px-8">
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm md:p-8">
          <div className="inline-flex items-center gap-2 rounded-full bg-emerald-100 px-3 py-1 text-sm font-medium text-emerald-700">
            <Database size={15} />
            Open Data · NGSI-LD · GET only
          </div>
          <h1 className="mt-4 text-3xl font-bold tracking-tight text-slate-900 md:text-4xl">
            SynapseCity Open API
          </h1>
          <p className="mt-3 max-w-3xl text-base leading-relaxed text-slate-600">
            SynapseCity chỉ công bố API mở NGSI-LD dạng <strong>GET</strong> cho
            dữ liệu tài sản và sự cố đã được publish qua Tier-2. Không cần API
            key, không có endpoint ghi, không có API vận hành nội bộ trên trang
            này.
          </p>

          <div className="mt-5 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
            <p className="font-semibold">Base URL</p>
            <code className="mt-1 block break-all font-mono text-emerald-800">
              {PUBLIC_API_BASE_URL}
            </code>
          </div>
        </section>

        <section className="mt-8">
          <h2 className="text-xl font-semibold text-slate-900">
            Endpoint công khai
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Chỉ các endpoint dưới đây là API mở. Tất cả đều là GET, read-only.
          </p>
          <div className="mt-4 grid gap-4">
            {publicEndpoints.map((endpoint) => (
              <EndpointCard key={endpoint.path} endpoint={endpoint} />
            ))}
          </div>
        </section>

        <section className="mt-8 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">Ví dụ</h2>
          <div className="mt-3 space-y-4">
            {curlExamples.map((example) => (
              <div key={example.label}>
                <p className="mb-1.5 text-sm font-medium text-slate-700">
                  {example.label}
                </p>
                <pre className="overflow-x-auto rounded-lg bg-slate-900 p-4 text-xs leading-relaxed text-slate-100">
                  <code>{example.command}</code>
                </pre>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-8 grid gap-4 md:grid-cols-2">
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-5">
            <div className="flex items-center gap-2 text-amber-800">
              <ShieldAlert size={18} />
              <h2 className="font-semibold">Không có API nội bộ ở đây</h2>
            </div>
            <p className="mt-2 text-sm leading-relaxed text-amber-900">
              Auth/session, quản trị người dùng, CRUD tài sản/sự cố, bảo trì,
              IoT, cảnh báo, ngân sách, báo cáo, geofence, ingest, map và AI là
              API vận hành của console. Chúng không được công bố như API mở và
              không xuất hiện trong tài liệu này.
            </p>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="font-semibold text-slate-900">Phạm vi dữ liệu</h2>
            <ul className="mt-2 space-y-1.5 text-sm text-slate-600">
              <li>Chỉ dữ liệu đã publish công khai qua Tier-2.</li>
              <li>Không trả về thông tin liên hệ hoặc ghi chú nội bộ.</li>
              <li>Không có endpoint POST/PUT/PATCH/DELETE.</li>
              <li>Không gọi API của SynapseCitySOS.</li>
              <li>
                Giấy phép dữ liệu:{" "}
                <a
                  href="https://opendatacommons.org/licenses/pddl/1-0/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-sky-600 hover:underline"
                >
                  PDDL 1.0
                </a>
                .
              </li>
            </ul>
            <a
              href="https://github.com/vku-open-source-2026/SynapseCity"
              target="_blank"
              rel="noopener noreferrer"
              className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-sky-600 hover:text-sky-700"
            >
              Mã nguồn & giới hạn sản phẩm
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
