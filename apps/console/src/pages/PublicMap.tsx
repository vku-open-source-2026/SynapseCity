// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useState, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearch, useNavigate } from "@tanstack/react-router";
import { getAssetId, type Asset } from "../api";
import { publicApi, type PublicAssetInfo } from "../api/public";
import MapComponent from "../components/Map";
import PublicMaintenanceSummary from "../components/PublicMaintenanceSummary";
import { useIoT } from "../hooks/useIoT";
import {
    AlertTriangle,
    ExternalLink,
    MessageCircle,
    X,
} from "lucide-react";
import Header from "../components/Header";
import QRCodeModal from "../components/QRCodeModal";
import NFCWriteModal from "../components/NFCWriteModal";
import ReportModal from "../components/ReportModal";
import { Button } from "@/components/ui/button";
import AIChatWidget from "../components/AIChatWidget";

// Extended Asset type with status added by the public projection
type AssetWithStatus = Asset & {
    status?: string;
    lastPing?: string;
};

/** Convert the public projection into the map's asset shape. */
function toMapAsset(asset: PublicAssetInfo): Asset {
    return {
        id: asset.id || asset.asset_code,
        _id: asset.id || asset.asset_code,
        feature_type: asset.feature_type,
        feature_code: asset.asset_code,
        geometry: (asset.location.geometry || {
            type: "Point",
            coordinates: [asset.location.coordinates.longitude, asset.location.coordinates.latitude],
        }) as Asset["geometry"],
        created_at: "",
    } as Asset;
}

const PublicMap: React.FC = () => {
    const navigate = useNavigate();
    const searchParams = useSearch({ from: "/map" }) as { assetId?: string };
    const {
        data: initialAssets,
        isLoading,
        error,
    } = useQuery({
        queryKey: ["assets"],
        // The public map reads the published projection only.
        queryFn: async () => (await publicApi.listPublicAssets({ limit: 500 })).map(toMapAsset),
        staleTime: 5 * 60 * 1000, // 5 minutes - prevent refetch on navigation
        refetchOnWindowFocus: false,
    });

    const { assetsWithStatus } = useIoT(initialAssets);
    const [selectedAsset, setSelectedAsset] = useState<Asset | null>(null);
    const [filteredAssets, setFilteredAssets] = useState<Asset[] | null>(null);
    const [routePoints] = useState<Asset[]>([]);
    const [showAssetInfoModal, setShowAssetInfoModal] = useState(false);

    const [showQRModal, setShowQRModal] = useState(false);
    const [showNFCModal, setShowNFCModal] = useState(false);
    const [showReportModal, setShowReportModal] = useState(false);
    const [openChatbot, setOpenChatbot] = useState(false);
    const [assetToAddToChat, setAssetToAddToChat] = useState<Asset | null>(null);

    // Use filtered assets if available, otherwise use live IoT assets
    const displayAssets = useMemo(() => {
        return filteredAssets || assetsWithStatus || [];
    }, [filteredAssets, assetsWithStatus]);

    // Sync URL param with selected asset - only on initial load or when assets are loaded
    const initialAssetIdRef = React.useRef(searchParams?.assetId);
    useEffect(() => {
        const assetId = initialAssetIdRef.current;
        if (assetId && displayAssets.length > 0 && !selectedAsset) {
            const asset = displayAssets.find((a) => getAssetId(a) === assetId);
            if (asset) {
                setSelectedAsset(asset);
                setShowAssetInfoModal(true);
            }
        }
    }, [displayAssets, selectedAsset]);

    const handleAssetSelect = (asset: Asset | null) => {
        setSelectedAsset(asset);
        setShowAssetInfoModal(asset !== null);
        // Close chat panel when opening asset details
        if (asset !== null) {
            setOpenChatbot(false);
            setAssetToAddToChat(null);
        }
        // Update URL without causing re-render
        const newUrl = asset
            ? `${window.location.pathname}?assetId=${getAssetId(asset)}`
            : window.location.pathname;
        window.history.replaceState({}, "", newUrl);
    };

    const handleCloseAssetInfoModal = () => {
        setShowAssetInfoModal(false);
        setSelectedAsset(null);
        // Update URL without causing re-render
        window.history.replaceState({}, "", window.location.pathname);
    };

    if (isLoading)
        return (
            <div className="flex h-screen items-center justify-center bg-slate-50">
                <div className="text-center">
                    <div className="w-16 h-16 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
                    <p className="text-slate-500 font-medium">
                        Đang tải tài nguyên hệ thống...
                    </p>
                </div>
            </div>
        );

    if (error)
        return (
            <div className="p-8 text-center text-red-500">
                Lỗi khi tải danh sách tài sản
            </div>
        );

    return (
        <div className="flex flex-col h-screen bg-slate-50 font-sans text-slate-900">
            <Header />

            <main className="flex-1 flex flex-col relative pt-20 z-0">

                {/* Fullscreen Map */}
                <div className="flex-1 w-full relative overflow-hidden">
                    <MapComponent
                        assets={displayAssets}
                        onAssetSelect={handleAssetSelect}
                        onFilterByShape={setFilteredAssets}
                        routePoints={routePoints}
                        selectedAsset={selectedAsset}
                        className="h-full w-full"
                        enableGeoSearches={true}
                    />
                </div>

                {/* Asset Info Modal */}
                {showAssetInfoModal && selectedAsset && (
                    <div className="fixed top-20 right-0 bottom-0 z-[1000] flex items-start justify-end p-4">
                        <div className="bg-white rounded-l-xl shadow-xl w-full max-w-2xl h-full overflow-hidden flex flex-col animate-in slide-in-from-right fade-in duration-200">
                            {/* Modal Header */}
                            <div className="p-6 border-b border-slate-100 bg-slate-50 flex items-start justify-between gap-3 shrink-0">
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 mb-2 flex-wrap">
                                        <span className="px-2 py-1 bg-blue-100 text-blue-700 text-xs font-bold rounded uppercase tracking-wide">
                                            {selectedAsset.feature_code}
                                        </span>
                                        <span className="text-xs text-slate-400">
                                            ID:{" "}
                                            {getAssetId(selectedAsset).slice(
                                                -6
                                            )}
                                        </span>
                                        {(selectedAsset as AssetWithStatus)
                                            .status && (
                                            <span
                                                className={`px-2 py-1 text-xs font-bold rounded uppercase tracking-wide ${
                                                    ["active", "operational"].includes(String((selectedAsset as AssetWithStatus).status))
                                                        ? "bg-green-100 text-green-700"
                                                        : ["maintenance", "under_repair"].includes(String((selectedAsset as AssetWithStatus).status))
                                                        ? "bg-amber-100 text-amber-700"
                                                        : "bg-slate-100 text-slate-600"
                                                }`}
                                            >
                                                {String((selectedAsset as AssetWithStatus).status).replace(/_/g, " ")}
                                            </span>
                                        )}
                                    </div>
                                    <h3 className="text-xl font-bold text-slate-900">
                                        {selectedAsset.feature_type}
                                    </h3>
                                </div>
                                <button
                                    onClick={handleCloseAssetInfoModal}
                                    className="p-1 hover:bg-slate-200 rounded transition-colors shrink-0"
                                    title="Đóng"
                                >
                                    <X size={20} />
                                </button>
                            </div>

                            {/* Modal Content */}
                            <div className="flex-1 overflow-y-auto p-6">
                                <div className="space-y-6">
                                    {/* Location */}
                                    <div>
                                        <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">
                                            Vị trí
                                        </h4>
                                        <div className="bg-slate-50 p-3 rounded-lg border border-slate-100">
                                            {selectedAsset.geometry.type ===
                                                "Point" &&
                                            Array.isArray(
                                                selectedAsset.geometry
                                                    .coordinates
                                            ) ? (
                                                <div className="grid grid-cols-2 gap-4 text-sm">
                                                    <div>
                                                        <p className="text-slate-500 text-xs">
                                                            Vĩ độ
                                                        </p>
                                                        <p className="font-mono font-medium">
                                                            {(
                                                                selectedAsset
                                                                    .geometry
                                                                    .coordinates[1] as number
                                                            ).toFixed(6)}
                                                        </p>
                                                    </div>
                                                    <div>
                                                        <p className="text-slate-500 text-xs">
                                                            Kinh độ
                                                        </p>
                                                        <p className="font-mono font-medium">
                                                            {(
                                                                selectedAsset
                                                                    .geometry
                                                                    .coordinates[0] as number
                                                            ).toFixed(6)}
                                                        </p>
                                                    </div>
                                                </div>
                                            ) : (
                                                <div className="text-sm">
                                                    <p className="text-slate-500 text-xs mb-1">
                                                        Loại hình học
                                                    </p>
                                                    <p className="font-mono font-medium mb-2">
                                                        {
                                                            selectedAsset
                                                                .geometry.type
                                                        }
                                                    </p>
                                                    <p className="text-slate-500 text-xs mb-1">
                                                        Chi tiết
                                                    </p>
                                                    <p className="font-mono font-medium">
                                                        {selectedAsset.geometry
                                                            .type ===
                                                        "LineString"
                                                            ? `${selectedAsset.geometry.coordinates.length} điểm`
                                                            : "Hình học phức tạp"}
                                                    </p>
                                                </div>
                                            )}
                                        </div>
                                    </div>

                                    {/* Maintenance History */}
                                    <div>
                                        <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">
                                            Lịch sử bảo trì
                                        </h4>
                                        <PublicMaintenanceSummary
                                            assetCode={String(selectedAsset.feature_code || getAssetId(selectedAsset))}
                                        />
                                    </div>
                                </div>
                            </div>

                            {/* Modal Actions */}
                            <div className="px-8 py-4 border-t border-slate-100 bg-slate-50 flex gap-2 shrink-0 justify-end">
                                <Button
                                    variant="outline"
                                    onClick={() => {
                                        setAssetToAddToChat(selectedAsset);
                                        setOpenChatbot(true);
                                        handleCloseAssetInfoModal();
                                    }}
                                    className="flex flex-row items-center gap-2"
                                >
                                    <MessageCircle size={16} />
                                    Thêm vào hội thoại
                                </Button>
                                <Button
                                    variant="outline"
                                    onClick={() => {
                                        const assetId =
                                            getAssetId(selectedAsset);
                                        navigate({
                                            to: "/asset/$id",
                                            params: { id: assetId },
                                        });
                                    }}
                                    className="flex flex-row items-center gap-2"
                                >
                                    <ExternalLink size={16} />
                                    Xem chi tiết
                                </Button>
                                <Button
                                    className="flex flex-row items-center gap-2"
                                    variant="destructive"
                                    onClick={() => setShowReportModal(true)}
                                >
                                    <AlertTriangle size={16} />
                                    Báo cáo
                                </Button>
                            </div>
                        </div>
                    </div>
                )}

                <QRCodeModal
                    isOpen={showQRModal}
                    onClose={() => setShowQRModal(false)}
                    asset={selectedAsset}
                />

                <NFCWriteModal
                    isOpen={showNFCModal}
                    onClose={() => setShowNFCModal(false)}
                    asset={selectedAsset}
                />

                <ReportModal
                    isOpen={showReportModal}
                    onClose={() => setShowReportModal(false)}
                    asset={selectedAsset}
                />

                {/* AI Chatbot Widget */}
                <AIChatWidget 
                    openChat={openChatbot}
                    onOpenChange={(isOpen) => {
                        setOpenChatbot(isOpen);
                        if (isOpen) {
                            // Close asset details panel when opening chat
                            setShowAssetInfoModal(false);
                            setSelectedAsset(null);
                            window.history.replaceState({}, "", window.location.pathname);
                        } else {
                            // Reset asset to add when closing
                            setAssetToAddToChat(null);
                        }
                    }}
                    addAssetToContext={assetToAddToChat}
                />
            </main>
        </div>
    );
};

export default PublicMap;
