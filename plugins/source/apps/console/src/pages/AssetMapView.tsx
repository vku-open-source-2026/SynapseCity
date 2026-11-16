// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { getAssets, getAssetId, type Asset } from "../api";
import { assetsApi } from "../api/assets";
import type { Asset as AssetDetail } from "../types/asset";
import MapComponent from "../components/Map";
import AssetInfoPanel from "../components/AssetInfoModal";
import AIChatWidget from "../components/AIChatWidget";

/**
 * Admin asset map. The map itself is the shared `MapComponent`, so this route
 * and the public map use the same pagination, icon and clustering behaviour.
 */
const AssetMapView: React.FC = () => {
    const navigate = useNavigate();
    const searchParams = useSearch({ from: "/admin/map" }) as {
        assetId?: string;
    };

    const {
        data: assets,
        isLoading,
        error,
    } = useQuery({
        // Distinct from the public map / other asset list queries: this one is
        // the complete operator inventory.
        queryKey: ["assets", "all"],
        queryFn: getAssets,
    });

    const [openChatbot, setOpenChatbot] = useState(false);
    const [assetToAddToChat, setAssetToAddToChat] = useState<Asset | null>(null);
    // The URL is the source of truth for the open asset panel, so map clicks,
    // deep links and the browser back button all behave the same way.
    const selectedAsset =
        (searchParams?.assetId &&
            assets?.find((asset) => getAssetId(asset) === searchParams.assetId)) ||
        null;
    const selectedAssetId = selectedAsset ? getAssetId(selectedAsset) : null;
    const isModalOpen = Boolean(selectedAsset);

    // Fetch the full detail record when the panel opens.
    const { data: fullAssetDetails, isLoading: isLoadingAssetDetails } =
        useQuery({
            queryKey: ["asset", selectedAssetId],
            queryFn: () => {
                if (!selectedAssetId) throw new Error("Asset ID is required");
                return assetsApi.getById(selectedAssetId);
            },
            enabled: !!selectedAssetId,
        });

    const handleAssetSelect = useCallback(
        (asset: Asset | null) => {
            if (!asset) {
                setOpenChatbot(false);
                setAssetToAddToChat(null);
                navigate({ to: "/admin/map", search: { assetId: undefined } });
                return;
            }
            const assetId = getAssetId(asset);
            if (!assetId) return;
            setOpenChatbot(false);
            setAssetToAddToChat(null);
            navigate({ to: "/admin/map", search: { assetId } });
        },
        [navigate]
    );

    const handleModalClose = useCallback(() => {
        navigate({ to: "/admin/map", search: { assetId: undefined } });
    }, [navigate]);

    const handleViewDetails = useCallback(
        (assetId: string) => {
            navigate({ to: "/admin/assets/$id", params: { id: assetId } });
        },
        [navigate]
    );

    const handleAddToChat = useCallback(
        (asset: Asset) => {
            setAssetToAddToChat(asset);
            setOpenChatbot(true);
            navigate({ to: "/admin/map", search: { assetId: undefined } });
        },
        [navigate]
    );

    if (error) {
        return (
            <div className="flex h-full items-center justify-center bg-slate-50">
                <div className="text-center">
                    <p className="text-red-500 font-medium mb-2">
                        Lỗi khi tải danh sách tài sản
                    </p>
                    <p className="text-sm text-slate-500">
                        Vui lòng thử làm mới trang
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div className="relative w-full h-full min-h-0 bg-slate-50 overflow-hidden z-0">
            {isLoading && (
                <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/80 backdrop-blur-sm">
                    <div className="text-center">
                        <div className="w-16 h-16 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
                        <p className="text-slate-500 font-medium">
                            Đang tải danh sách tài sản...
                        </p>
                    </div>
                </div>
            )}

            <MapComponent
                assets={assets || []}
                onAssetSelect={handleAssetSelect}
                selectedAsset={selectedAsset}
                initialZoom={13}
                className="h-full w-full"
            />

            <AssetInfoPanel
                asset={(fullAssetDetails || selectedAsset) as unknown as AssetDetail | null}
                isOpen={isModalOpen}
                onClose={handleModalClose}
                onViewDetails={handleViewDetails}
                onAddToChat={handleAddToChat}
                isLoading={isLoadingAssetDetails}
            />

            <AIChatWidget
                openChat={openChatbot}
                onOpenChange={(isOpen) => {
                    setOpenChatbot(isOpen);
                    if (isOpen) {
                        navigate({ to: "/admin/map", search: { assetId: undefined } });
                    } else {
                        setAssetToAddToChat(null);
                    }
                }}
                addAssetToContext={assetToAddToChat}
            />
        </div>
    );
};

export default AssetMapView;
