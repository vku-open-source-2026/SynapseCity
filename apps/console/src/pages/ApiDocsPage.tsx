// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import Header from "../components/Header";
import Footer from "../components/Footer";
import AIChatWidget from "../components/AIChatWidget";
import { Code, Copy, Check, Database, ExternalLink, Key, ShieldAlert } from "lucide-react";
import { useState } from "react";

/**
 * City API documentation.
 *
 * Only endpoints implemented by apps/city-service are documented here. The
 * public host is https://synapsecity.sbs; legacy open-data and MCP examples
 * were removed because this service never implemented them.
 */
const API_BASE_URL = "https://synapsecity.sbs/v1";

interface Endpoint {
  method: string;
  path: string;
  title: string;
  description: string;
}

interface EndpointGroup {
  id: string;
  label: string;
  icon: string;
  description: string;
  endpoints: Endpoint[];
}

const endpointGroups: EndpointGroup[] = [
  {
    id: "metadata",
    label: "Thông tin dịch vụ",
    icon: "🏙️",
    description: "Metadata về sản phẩm City, ranh giới sở hữu và dependency Tier-2.",
    endpoints: [
      { method: "GET", path: "/city", title: "Product metadata", description: "features, notOwned, datasets và Tier-2 dependency." },
      { method: "GET", path: "/map/config", title: "Map tile configuration", description: "Cấu hình tile VietMap/OpenStreetMap cho console." },
      { method: "GET", path: "/ai/status", title: "AI capability status", description: "Trạng thái capability AI của City." },
    ],
  },
  {
    id: "auth",
    label: "Xác thực",
    icon: "🔐",
    description:
      "Session shell HMAC-SHA256. Mật khẩu không được lưu; production phải uỷ quyền định danh cho Tier-1 IAM.",
    endpoints: [
      { method: "POST", path: "/auth/login", title: "Login", description: "{ username, password } → access_token, refresh_token, user." },
      { method: "POST", path: "/auth/register", title: "Register", description: "{ username, email, password, full_name, phone? } → session." },
      { method: "POST", path: "/auth/refresh", title: "Refresh", description: "{ refresh_token } → session mới." },
      { method: "POST", path: "/auth/logout", title: "Logout", description: "204 No Content." },
      { method: "POST", path: "/auth/change-password", title: "Change password", description: "204; Tier-1 IAM sở hữu mật khẩu." },
      { method: "GET", path: "/auth/me", title: "Current session", description: "Principal từ Bearer token." },
      { method: "GET", path: "/auth/verify", title: "Verify token", description: "{ valid, user_id, role, permissions }." },
    ],
  },
  {
    id: "public",
    label: "Dữ liệu công khai",
    icon: "📦",
    description: "Bản đồ tài sản công khai và báo cáo sự cố của người dân.",
    endpoints: [
      { method: "GET", path: "/public/assets", title: "Danh sách tài sản công khai", description: "Projection công khai của city-assets." },
      { method: "GET", path: "/public/assets/:code", title: "Tra cứu tài sản", description: "Theo asset_code, feature_code hoặc id." },
      { method: "GET", path: "/public/assets/:code/qr-code", title: "QR code", description: "{ asset_code, qr_code, url }." },
      { method: "GET", path: "/public/incidents", title: "Sự cố công khai", description: "Chỉ các báo cáo public_visible." },
      { method: "POST", path: "/public/incidents", title: "Báo sự cố ẩn danh", description: "{ title, description, category, severity, location? }." },
      { method: "GET", path: "/public/incidents/:ref", title: "Tra cứu báo cáo", description: "Theo id hoặc incident_number." },
      { method: "POST", path: "/public/incidents/:id/photos", title: "Ảnh báo cáo", description: "{ photos: string[] } (data URL hoặc URL công khai)." },
    ],
  },
  {
    id: "assets",
    label: "Tài sản & vòng đời",
    icon: "🏗️",
    description: "Asset registry, GIS, sức khoẻ, tài liệu và báo cáo tài sản.",
    endpoints: [
      { method: "GET", path: "/assets", title: "Danh sách tài sản", description: "Lọc status, category, feature_type." },
      { method: "POST", path: "/assets", title: "Tạo tài sản", description: "Tên, mã, loại, geometry và metadata." },
      { method: "GET", path: "/assets/:id", title: "Chi tiết tài sản", description: "Theo id, asset_code hoặc feature_code." },
      { method: "PUT", path: "/assets/:id", title: "Cập nhật tài sản", description: "Cập nhật toàn bộ trường gửi lên." },
      { method: "DELETE", path: "/assets/:id", title: "Xoá mềm tài sản", description: "Đánh dấu decommissioned, giữ audit." },
      { method: "PUT", path: "/assets/:id/lifecycle-status", title: "Lifecycle status", description: "operational | under_repair | damaged | decommissioned." },
      { method: "GET", path: "/assets/:id/health-score", title: "Health score", description: "Điểm sức khoẻ và breakdown 5 thành phần." },
      { method: "GET", path: "/assets/:id/documents", title: "Tài liệu", description: "Danh sách attachment metadata." },
      { method: "POST", path: "/assets/:id/documents", title: "Thêm tài liệu", description: "JSON metadata (file_url data URL hoặc public URL)." },
      { method: "POST", path: "/assets/:id/photos", title: "Ảnh tài sản", description: "{ photos: string[] }." },
      { method: "POST", path: "/assets/:id/reports", title: "Tạo báo cáo", description: "{ report_type, format, filters } → report_url." },
    ],
  },
  {
    id: "incidents",
    label: "Sự cố & quy trình",
    icon: "🚧",
    description: "Quản lý sự cố hạ tầng, bình luận, xác minh và điều phối.",
    endpoints: [
      { method: "GET", path: "/incidents", title: "Danh sách sự cố", description: "Lọc status, severity, asset_id, assigned_to." },
      { method: "POST", path: "/incidents", title: "Tạo sự cố", description: "Sự cố do operator tạo." },
      { method: "GET", path: "/incidents/:id", title: "Chi tiết sự cố", description: "Theo id hoặc incident_number." },
      { method: "PUT", path: "/incidents/:id", title: "Cập nhật sự cố", description: "Cập nhật trạng thái và metadata." },
      { method: "POST", path: "/incidents/:id/comments", title: "Bình luận", description: "Ghi chú nội bộ hoặc công khai." },
      { method: "POST", path: "/incidents/:id/assign", title: "Phân công", description: "?assigned_to=..." },
      { method: "POST", path: "/incidents/:id/resolve", title: "Xử lý", description: "?resolution_notes=&resolution_type=." },
      { method: "POST", path: "/incidents/:id/upvote", title: "Bình chọn", description: "Tăng upvotes." },
      { method: "POST", path: "/incidents/:id/verify", title: "Xác minh", description: "Đánh dấu verified bởi operator." },
      { method: "GET", path: "/incidents/:id/related", title: "Sự cố liên quan", description: "Cùng asset hoặc đã merge." },
    ],
  },
  {
    id: "operations",
    label: "Vận hành",
    icon: "🛠️",
    description: "Bảo trì, IoT, cảnh báo, ngân sách, báo cáo, thông báo và người dùng.",
    endpoints: [
      { method: "GET", path: "/maintenance", title: "Work orders", description: "Danh sách bảo trì." },
      { method: "GET", path: "/maintenance/upcoming", title: "Sắp tới", description: "?days=7 (tối đa 30)." },
      { method: "GET", path: "/maintenance/asset/:assetId", title: "Theo tài sản", description: "Lịch sử bảo trì của asset." },
      { method: "GET", path: "/iot/sensors", title: "Cảm biến", description: "Metadata cảm biến IoT." },
      { method: "GET", path: "/iot/sensors/:id/data", title: "Readings", description: "Dữ liệu đo của cảm biến." },
      { method: "GET", path: "/alerts", title: "Cảnh báo hạ tầng", description: "Infrastructure alerts (không phải hazard SOS)." },
      { method: "GET", path: "/budgets", title: "Ngân sách", description: "Ngân sách và giao dịch." },
      { method: "GET", path: "/reports", title: "Báo cáo vận hành", description: "Báo cáo do City tạo." },
      { method: "GET", path: "/notifications", title: "Thông báo", description: "Thông báo nội bộ City." },
      { method: "GET", path: "/users", title: "Người dùng City", description: "Yêu cầu Bearer token; chỉ admin." },
      { method: "GET", path: "/users/me", title: "Hồ sơ hiện tại", description: "Principal từ token, không phải bản ghi đầu tiên." },
      { method: "GET", path: "/users/technicians", title: "Kỹ thuật viên", description: "Yêu cầu quyền admin." },
      { method: "GET", path: "/users/volunteers", title: "Tình nguyện viên", description: "Yêu cầu quyền admin." },
      { method: "POST", path: "/ingest/csv", title: "Nhập CSV", description: "{ filename, content } → { accepted, created, errors }." },
      { method: "GET", path: "/geofences", title: "Geofences", description: "Vùng địa lý vận hành." },
      { method: "GET", path: "/map/status", title: "Map status", description: "Provider và cấu hình bản đồ." },
    ],
  },
];

const curlExamples = [
  `# Public asset lookup
curl "${API_BASE_URL}/public/assets/ASSET-001"`,
  `# Citizen incident report
curl -X POST "${API_BASE_URL}/public/incidents" \\
  -H "content-type: application/json" \\
  -d '{"title":"Pothole","description":"Main street","category":"damage","severity":"high"}'`,
  `# Operator session
TOKEN=$(curl -s -X POST "${API_BASE_URL}/auth/login" \\
  -H "content-type: application/json" \\
  -d '{"username":"operator","password":"demo"}' | jq -r .access_token)
curl "${API_BASE_URL}/users" -H "Authorization: Bearer $TOKEN"`,
];

function EndpointRow({ endpoint }: { endpoint: Endpoint }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${API_BASE_URL}${endpoint.path}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be unavailable outside a secure context.
    }
  };

  return (
    <div className="flex flex-col md:flex-row md:items-start gap-3 p-4 bg-white rounded-xl border border-slate-200 hover:border-blue-200 hover:shadow-sm transition-all">
      <span
        className={`inline-flex items-center justify-center px-2.5 py-1 rounded-md text-xs font-bold shrink-0 ${
          endpoint.method === "GET"
            ? "bg-emerald-100 text-emerald-700"
            : endpoint.method === "POST"
            ? "bg-blue-100 text-blue-700"
            : endpoint.method === "DELETE"
            ? "bg-red-100 text-red-700"
            : "bg-amber-100 text-amber-700"
        }`}
      >
        {endpoint.method}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <code className="text-sm font-mono text-slate-900 break-all">{endpoint.path}</code>
          <span className="text-sm font-medium text-slate-700">{endpoint.title}</span>
        </div>
        <p className="text-sm text-slate-500 mt-1">{endpoint.description}</p>
      </div>
      <button
        onClick={copy}
        className="self-start p-2 rounded-lg text-slate-400 hover:text-blue-600 hover:bg-blue-50 transition-colors"
        title="Copy endpoint URL"
      >
        {copied ? <Check size={16} /> : <Copy size={16} />}
      </button>
    </div>
  );
}

export default function ApiDocsPage() {
  const scrollTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white">
      <Header />

      <aside className="hidden lg:block fixed left-0 top-20 w-60 h-[calc(100vh-5rem)] bg-white border-r border-slate-200 p-4 overflow-y-auto z-40">
        <nav className="space-y-1">
          <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3 px-3">
            Điều hướng
          </h3>
          {endpointGroups.map((group) => (
            <button
              key={group.id}
              onClick={() => scrollTo(group.id)}
              className="w-full flex items-center gap-3 px-3 py-2 text-sm text-slate-700 hover:bg-slate-100 hover:text-blue-600 rounded-lg transition-colors text-left"
            >
              <span>{group.icon}</span>
              <span>{group.label}</span>
            </button>
          ))}
        </nav>
      </aside>

      <main className="pt-24 pb-16 lg:ml-60">
        <section className="max-w-6xl mx-auto px-4 mb-12">
          <div className="text-center mb-8">
            <div className="inline-flex items-center gap-2 bg-blue-100 text-blue-700 px-4 py-2 rounded-full text-sm font-medium mb-4">
              <Database size={16} />
              SynapseCity API
            </div>
            <h1 className="text-4xl md:text-5xl font-bold text-slate-900 mb-4">
              Tài liệu API City
            </h1>
            <p className="text-xl text-slate-600 max-w-2xl mx-auto">
              API hạ tầng đô thị của SynapseCity. Tất cả endpoint dưới đây được
              triển khai bởi <code className="text-base">apps/city-service</code> và
              công bố tại{" "}
              <a className="text-blue-600 hover:underline" href="https://synapsecity.sbs">
                https://synapsecity.sbs
              </a>
              .
            </p>
            <div className="inline-flex items-center gap-2 mt-4 px-4 py-2 bg-slate-900 text-white rounded-lg font-mono text-sm">
              <Code size={16} />
              {API_BASE_URL}
            </div>
          </div>

          <div className="bg-blue-50 border border-blue-200 rounded-2xl p-6 flex items-start gap-4">
            <Key className="text-blue-600 shrink-0 mt-1" size={22} />
            <div>
              <h2 className="font-semibold text-slate-900">Xác thực</h2>
              <p className="text-sm text-slate-700 mt-1">
                Các endpoint vận hành yêu cầu header{" "}
                <code className="bg-white px-1.5 py-0.5 rounded border border-blue-200">
                  Authorization: Bearer &lt;access_token&gt;
                </code>
                . Lấy token qua <code>POST /auth/login</code>. Đây là session shell
                HMAC của City; mật khẩu không được kiểm chứng hay lưu trữ (chế độ
                demo: mọi username/password không rỗng đều nhận session) và
                production phải uỷ quyền định danh cho Tier-1 IAM. Public asset
                lookup và public incident reporting không yêu cầu token.
              </p>
            </div>
          </div>
        </section>

        <section className="max-w-6xl mx-auto px-4 mb-12">
          <div className="bg-amber-50 border border-amber-200 rounded-2xl p-6 flex items-start gap-4">
            <ShieldAlert className="text-amber-600 shrink-0 mt-1" size={22} />
            <div>
              <h2 className="font-semibold text-slate-900">Ranh giới sản phẩm</h2>
              <p className="text-sm text-slate-700 mt-1">
                SynapseCity sở hữu hạ tầng đô thị: tài sản, sự cố, bảo trì, IoT,
                cảnh báo hạ tầng, ngân sách, báo cáo vận hành, geofence, ingest và
                người dùng City. Hazard feed, emergency event, EOP, dispatch,
                SITREP, AAR và command centre thuộc SynapseCitySOS tại{" "}
                <a
                  className="text-blue-600 hover:underline"
                  href="https://sos.synapsecity.sbs"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  sos.synapsecity.sbs
                  <ExternalLink className="inline ml-1" size={12} />
                </a>
                . City không gọi API SOS và không đọc/ghi dataset <code>sos-*</code>.
              </p>
            </div>
          </div>
        </section>

        {endpointGroups.map((group) => (
          <section key={group.id} id={group.id} className="max-w-6xl mx-auto px-4 mb-12 scroll-mt-24">
            <h2 className="text-2xl font-bold text-slate-900 mb-1 flex items-center gap-3">
              <span>{group.icon}</span>
              {group.label}
            </h2>
            <p className="text-slate-500 mb-5">{group.description}</p>
            <div className="space-y-3">
              {group.endpoints.map((endpoint) => (
                <EndpointRow key={`${endpoint.method}-${endpoint.path}`} endpoint={endpoint} />
              ))}
            </div>
          </section>
        ))}

        <section id="examples" className="max-w-6xl mx-auto px-4 mb-12 scroll-mt-24">
          <h2 className="text-2xl font-bold text-slate-900 mb-1 flex items-center gap-3">
            <Code size={24} className="text-blue-600" />
            Ví dụ
          </h2>
          <p className="text-slate-500 mb-5">
            Tất cả ví dụ dùng host công khai <code>https://synapsecity.sbs/v1</code>.
          </p>
          <div className="space-y-4">
            {curlExamples.map((example) => (
              <pre
                key={example}
                className="bg-slate-900 text-slate-100 rounded-xl p-4 overflow-x-auto text-sm font-mono whitespace-pre"
              >
                {example}
              </pre>
            ))}
          </div>
        </section>

        <section className="max-w-6xl mx-auto px-4">
          <div className="bg-white border border-slate-200 rounded-2xl p-6">
            <h2 className="text-lg font-semibold text-slate-900 mb-2">Phạm vi tài liệu</h2>
            <p className="text-sm text-slate-600">
              Trang này chỉ liệt kê các endpoint do City service triển khai. Các
              hostname và namespace open-data/MCP legacy không thuộc API hiện tại
              và đã được loại bỏ khỏi tài liệu. Dữ liệu công khai được phục vụ qua
              <code> /public/*</code> trên host City.
            </p>
          </div>
        </section>
      </main>

      <Footer />
      <AIChatWidget />
    </div>
  );
}
