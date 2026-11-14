// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { reportsApi } from "../../api/reports"
import { ReportCard } from "../../components/reports/ReportCard"
import { Select } from "../../components/ui/select"
import { Pagination } from "../../components/ui/pagination"
import { Skeleton } from "../../components/ui/skeleton"
import { Plus } from "lucide-react"

const ReportList: React.FC = () => {
  const [page, setPage] = useState(1)
  const [type, setType] = useState<string>("")
  const [status, setStatus] = useState<string>("")
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const limit = 20

  const { data: reportPage, isLoading } = useQuery({
    queryKey: ["reports", page, type, status],
    queryFn: () =>
      reportsApi.listPage({
        skip: (page - 1) * limit,
        limit,
        type: type || undefined,
        status: status || undefined,
      }),
    // Poll while any report is still generating, without reloading the tab.
    refetchInterval: (query) =>
      query.state.data?.items.some((report) => report.status === "generating") ? 5000 : false,
  })
  const reports = reportPage?.items ?? []

  const handleDownload = async (reportId: string) => {
    setDownloadError(null)
    try {
      const { url, filename } = await reportsApi.download(reportId)
      const link = document.createElement("a")
      link.href = url
      link.download = filename
      link.click()
      URL.revokeObjectURL(url)
    } catch (error) {
      console.error("Tải báo cáo thất bại:", error)
      setDownloadError("Tải báo cáo thất bại. Vui lòng thử lại.")
    }
  }

  const totalPages = reportPage ? Math.max(1, Math.ceil(reportPage.total / limit)) : 1

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Báo cáo</h1>
          <p className="text-slate-500 mt-1">Xem và tải xuống các báo cáo đã tạo</p>
        </div>
        <Link
          to="/admin/reports/create"
          className="inline-flex h-10 items-center justify-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700"
        >
          <Plus className="h-4 w-4 mr-2" />
          Tạo báo cáo
        </Link>
      </div>

      <div className="flex gap-4">
        <Select
          value={type}
          onChange={(e) => setType(e.target.value)}
          placeholder="Tất cả loại"
        >
          <option value="">Tất cả loại</option>
          <option value="maintenance">Bảo trì</option>
          <option value="incident">Sự cố</option>
          <option value="asset">Tài sản</option>
        </Select>
        <Select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          placeholder="Tất cả trạng thái"
        >
          <option value="">Tất cả trạng thái</option>
          <option value="pending">Đang chờ</option>
          <option value="generating">Đang tạo</option>
          <option value="completed">Hoàn thành</option>
          <option value="failed">Thất bại</option>
        </Select>
      </div>

      {downloadError && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {downloadError}
        </div>
      )}

      {isLoading ? (
        <div className="space-y-4">
          {[...Array(5)].map((_, i) => (
            <Skeleton key={i} className="h-32 w-full" />
          ))}
        </div>
      ) : reports && reports.length > 0 ? (
        <>
          <div className="space-y-4">
            {reports.map((report) => (
              <ReportCard
                key={report.id}
                report={report}
                onDownload={() => handleDownload(report.id)}
              />
            ))}
          </div>
          {totalPages > 1 && (
            <Pagination currentPage={page} totalPages={totalPages} onPageChange={setPage} />
          )}
        </>
      ) : (
        <div className="text-center py-12 text-slate-500">
          <p>Không tìm thấy báo cáo.</p>
        </div>
      )}
    </div>
  )
}

export default ReportList
