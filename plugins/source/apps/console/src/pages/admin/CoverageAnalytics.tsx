// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { BarChart3, Play } from "lucide-react";
import { analyticsApi, type CoverageArea, type CoverageReport } from "../../api/analytics";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";

const DEFAULT_AREAS = JSON.stringify(
    [
        {
            name: "Quận Hoàn Kiếm",
            population: 135000,
            bbox: { minLng: 105.84, minLat: 21.01, maxLng: 105.87, maxLat: 21.04 },
            asset_types: ["street_light", "hydrant"],
        },
        {
            name: "Quận Ba Đình",
            population: 220000,
            bbox: { minLng: 105.8, minLat: 21.02, maxLng: 105.84, maxLat: 21.06 },
            asset_types: ["street_light", "traffic_signal"],
        },
    ],
    null,
    2,
);

const priorityClass: Record<CoverageReport["areas"][number]["priority"], string> = {
    critical: "bg-red-100 text-red-700",
    high: "bg-orange-100 text-orange-700",
    medium: "bg-amber-100 text-amber-700",
    low: "bg-green-100 text-green-700",
};

/**
 * GIS coverage gaps with population-weighted prioritisation. Calculation:
 * gap = 50% coverage shortfall + 30% open-incident pressure + 20% demand
 * pressure (population per asset / target). See city-service `analytics.ts`.
 */
export default function CoverageAnalytics() {
    const [areasJson, setAreasJson] = useState(DEFAULT_AREAS);
    const [radius, setRadius] = useState("500");
    const [target, setTarget] = useState("2000");
    const [parseError, setParseError] = useState<string | null>(null);

    const mutation = useMutation({
        mutationFn: async () => {
            let areas: CoverageArea[];
            try {
                areas = JSON.parse(areasJson) as CoverageArea[];
            } catch {
                throw new Error("JSON khu vực không hợp lệ.");
            }
            if (!Array.isArray(areas) || areas.length === 0) throw new Error("Cần ít nhất một khu vực.");
            return analyticsApi.coverage({
                areas,
                service_radius_meters: Number(radius) || undefined,
                target_population_per_asset: Number(target) || undefined,
            });
        },
        onMutate: () => setParseError(null),
        onError: (error) => setParseError((error as Error).message),
    });

    const report = mutation.data;

    return (
        <div className="p-6 space-y-6">
            <div>
                <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
                    <BarChart3 className="h-6 w-6 text-blue-600" />
                    Phân tích vùng phủ GIS
                </h1>
                <p className="text-slate-500 mt-1">
                    Khoảng trống hạ tầng theo khu vực, có trọng số dân số và sự cố đang mở.
                </p>
            </div>

            <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <label className="space-y-1 block">
                        <span className="text-sm font-medium text-slate-700">Bán kính phục vụ (m)</span>
                        <Input value={radius} onChange={(event) => setRadius(event.target.value)} inputMode="numeric" />
                    </label>
                    <label className="space-y-1 block">
                        <span className="text-sm font-medium text-slate-700">Dân số mục tiêu / tài sản</span>
                        <Input value={target} onChange={(event) => setTarget(event.target.value)} inputMode="numeric" />
                    </label>
                </div>
                <label className="space-y-1 block">
                    <span className="text-sm font-medium text-slate-700">Khu vực (JSON)</span>
                    <textarea
                        value={areasJson}
                        onChange={(event) => setAreasJson(event.target.value)}
                        rows={14}
                        className="w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs"
                    />
                </label>
                <Button onClick={() => mutation.mutate()} disabled={mutation.isPending}>
                    <Play className="h-4 w-4 mr-2" />
                    {mutation.isPending ? "Đang phân tích..." : "Phân tích"}
                </Button>
                {parseError && <p className="text-sm text-red-600" role="alert">{parseError}</p>}
            </div>

            {report && (
                <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                    <div className="px-6 py-4 border-b border-slate-100 text-sm text-slate-500">
                        Bán kính {report.service_radius_meters} m · mục tiêu {report.target_population_per_asset} người/tài sản · tạo lúc{" "}
                        {new Date(report.generated_at).toLocaleString("vi-VN")}
                    </div>
                    <table className="w-full text-sm">
                        <thead className="bg-slate-50 text-slate-500 uppercase text-xs">
                            <tr>
                                <th className="text-left px-6 py-3">Khu vực</th>
                                <th className="text-right px-4 py-3">Dân số</th>
                                <th className="text-right px-4 py-3">Tài sản</th>
                                <th className="text-right px-4 py-3">Người/tài sản</th>
                                <th className="text-right px-4 py-3">Sự cố mở</th>
                                <th className="text-right px-4 py-3">Điểm thiếu hụt</th>
                                <th className="text-left px-6 py-3">Ưu tiên</th>
                            </tr>
                        </thead>
                        <tbody>
                            {report.areas.map((area) => (
                                <tr key={area.area} className="border-t border-slate-100">
                                    <td className="px-6 py-3">
                                        <div className="font-medium text-slate-900">{area.area}</div>
                                        {area.missing_asset_types.length > 0 && (
                                            <div className="text-xs text-red-600">
                                                Thiếu: {area.missing_asset_types.join(", ")}
                                            </div>
                                        )}
                                    </td>
                                    <td className="px-4 py-3 text-right">{area.population.toLocaleString("vi-VN")}</td>
                                    <td className="px-4 py-3 text-right">{area.asset_count}</td>
                                    <td className="px-4 py-3 text-right">{area.population_per_asset.toLocaleString("vi-VN")}</td>
                                    <td className="px-4 py-3 text-right">{area.open_incident_count}</td>
                                    <td className="px-4 py-3 text-right font-semibold">{area.gap_score}</td>
                                    <td className="px-6 py-3">
                                        <span className={`px-2 py-1 rounded-full text-xs font-bold uppercase ${priorityClass[area.priority]}`}>
                                            {area.priority}
                                        </span>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
