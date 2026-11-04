// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { useQuery } from "@tanstack/react-query";
import { Calendar, CheckCircle, Clock } from "lucide-react";
import { publicApi } from "../api/public";

interface PublicMaintenanceSummaryProps {
    assetCode: string;
}

/**
 * Public pages must never call the private maintenance namespace. This widget
 * reads the public aggregate summary (counts and last completion only).
 */
const PublicMaintenanceSummary: React.FC<PublicMaintenanceSummaryProps> = ({ assetCode }) => {
    const { data, isLoading, error } = useQuery({
        queryKey: ["public-maintenance-summary", assetCode],
        queryFn: () => publicApi.getMaintenanceSummary(assetCode),
        enabled: !!assetCode,
    });

    if (isLoading) {
        return <div className="text-sm text-slate-500 py-4">Đang tải thông tin bảo trì...</div>;
    }
    if (error) {
        return <div className="text-sm text-slate-400 py-4 italic">Chưa có thông tin bảo trì công khai.</div>;
    }
    if (!data || data.work_order_count === 0) {
        return <div className="text-sm text-slate-400 py-4 italic">Chưa có lịch sử bảo trì.</div>;
    }

    return (
        <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm text-slate-700">
                <Calendar size={16} className="text-slate-400" />
                <span>Tổng số phiếu bảo trì: {data.work_order_count}</span>
            </div>
            <div className="flex items-center gap-2 text-sm text-slate-700">
                <CheckCircle size={16} className="text-green-600" />
                <span>Đã hoàn thành: {data.completed_count}</span>
            </div>
            <div className="flex items-center gap-2 text-sm text-slate-700">
                <Clock size={16} className="text-slate-400" />
                <span>
                    Lần hoàn thành gần nhất:{" "}
                    {data.last_completed_at
                        ? new Date(data.last_completed_at).toLocaleDateString("vi-VN")
                        : "N/A"}
                    {data.last_maintenance_type ? ` (${data.last_maintenance_type})` : ""}
                </span>
            </div>
        </div>
    );
};

export default PublicMaintenanceSummary;
