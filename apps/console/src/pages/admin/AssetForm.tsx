// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { ArrowLeft, Save } from "lucide-react";
import { assetsApi } from "../../api/assets";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Skeleton } from "../../components/ui/skeleton";
import type { Asset, AssetCreateRequest, AssetGeometry, AssetStatus } from "../../types/asset";

interface AssetFormProps {
    mode: "create" | "edit";
}

const FEATURE_TYPES = [
    "street_light",
    "hydrant",
    "traffic_signal",
    "bridge",
    "road",
    "drainage",
    "park",
    "building",
    "infrastructure",
];

const STATUSES: AssetStatus[] = ["active", "inactive", "maintenance", "decommissioned"];
const CONDITIONS = ["excellent", "good", "fair", "poor", "critical"];
const LIFECYCLE_STAGES = ["operational", "under_repair", "damaged", "decommissioned"];

interface FormState {
    asset_code: string;
    name: string;
    feature_type: string;
    feature_code: string;
    category: string;
    status: AssetStatus;
    condition: string;
    lifecycle_stage: string;
    address: string;
    longitude: string;
    latitude: string;
    owner: string;
    municipality: string;
}

const EMPTY: FormState = {
    asset_code: "",
    name: "",
    feature_type: "infrastructure",
    feature_code: "",
    category: "",
    status: "active",
    condition: "good",
    lifecycle_stage: "operational",
    address: "",
    longitude: "",
    latitude: "",
    owner: "",
    municipality: "",
};

function validate(form: FormState): Record<string, string> {
    const errors: Record<string, string> = {};
    if (!form.name.trim()) errors.name = "Tên tài sản là bắt buộc.";
    if (!form.asset_code.trim()) errors.asset_code = "Mã tài sản là bắt buộc.";
    if (!form.feature_type.trim()) errors.feature_type = "Loại tài sản là bắt buộc.";
    if (!form.feature_code.trim()) errors.feature_code = "Mã loại hình là bắt buộc.";
    const longitude = Number(form.longitude);
    const latitude = Number(form.latitude);
    if (form.longitude !== "" && !Number.isFinite(longitude)) errors.longitude = "Kinh độ phải là số.";
    if (form.latitude !== "" && !Number.isFinite(latitude)) errors.latitude = "Vĩ độ phải là số.";
    if (Number.isFinite(longitude) && Math.abs(longitude) > 180) errors.longitude = "Kinh độ nằm trong [-180, 180].";
    if (Number.isFinite(latitude) && Math.abs(latitude) > 90) errors.latitude = "Vĩ độ nằm trong [-90, 90].";
    return errors;
}

function toGeometry(form: FormState): AssetGeometry {
    return {
        type: "Point",
        coordinates: [Number(form.longitude), Number(form.latitude)],
    };
}

function formFromAsset(existing?: Asset): FormState {
    if (!existing) return EMPTY;
    const coordinates = Array.isArray(existing.geometry?.coordinates)
        ? existing.geometry.coordinates as number[]
        : [];
    return {
        asset_code: existing.asset_code || "",
        name: existing.name || "",
        feature_type: existing.feature_type || "infrastructure",
        feature_code: existing.feature_code || "",
        category: existing.category || "",
        status: (existing.status as AssetStatus) || "active",
        condition: existing.condition || "good",
        lifecycle_stage: existing.lifecycle_stage || existing.lifecycle?.lifecycle_status || "operational",
        address: existing.location?.address || "",
        longitude: Number.isFinite(coordinates[0]) ? String(coordinates[0]) : "",
        latitude: Number.isFinite(coordinates[1]) ? String(coordinates[1]) : "",
        owner: existing.owner || "",
        municipality: "",
    };
}

interface AssetFormBodyProps extends AssetFormProps {
    assetId: string;
    initial: FormState;
}

function AssetFormBody({ mode, assetId, initial }: AssetFormBodyProps) {
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const [form, setForm] = useState<FormState>(initial);
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [submitted, setSubmitted] = useState(false);

    const mutation = useMutation({
        mutationFn: async (payload: AssetCreateRequest) => {
            if (mode === "edit") return assetsApi.update(assetId, payload);
            return assetsApi.create(payload);
        },
        onSuccess: async (asset) => {
            await queryClient.invalidateQueries({ queryKey: ["assets"] });
            navigate({ to: `/admin/assets/${asset.id}` });
        },
    });

    const title = mode === "create" ? "Tạo tài sản" : "Chỉnh sửa tài sản";

    const update = (key: keyof FormState, value: string) => {
        setForm((current) => ({ ...current, [key]: value }));
        setErrors((current) => ({ ...current, [key]: "" }));
    };

    const submit = (event: React.FormEvent) => {
        event.preventDefault();
        setSubmitted(true);
        const nextErrors = validate(form);
        setErrors(nextErrors);
        if (Object.keys(nextErrors).length > 0) return;
        const payload: AssetCreateRequest = {
            asset_code: form.asset_code.trim(),
            name: form.name.trim(),
            feature_type: form.feature_type.trim(),
            feature_code: form.feature_code.trim(),
            category: form.category.trim() || undefined,
            status: form.status,
            condition: form.condition || undefined,
            lifecycle_stage: form.lifecycle_stage || undefined,
            geometry: toGeometry(form),
            location: {
                address: form.address.trim(),
                ...(form.municipality.trim() ? { city: form.municipality.trim() } : {}),
            },
            ...(form.owner.trim() ? { owner: form.owner.trim() } : {}),
        };
        mutation.mutate(payload);
    };

    return (
        <div className="p-6 space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-slate-900">{title}</h1>
                    <p className="text-slate-500 mt-1">Thông tin tài sản hạ tầng và vị trí GIS</p>
                </div>
                <Button variant="outline" onClick={() => navigate({ to: "/admin/assets" })}>
                    <ArrowLeft className="h-4 w-4 mr-2" />
                    Quay lại
                </Button>
            </div>

            <form onSubmit={submit} className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 space-y-5">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <label className="space-y-1 block">
                        <span className="text-sm font-medium text-slate-700">Tên tài sản *</span>
                        <Input value={form.name} onChange={(event) => update("name", event.target.value)} placeholder="Đèn đường Nguyễn Huệ" />
                        {errors.name && <span className="text-xs text-red-600">{errors.name}</span>}
                    </label>
                    <label className="space-y-1 block">
                        <span className="text-sm font-medium text-slate-700">Mã tài sản *</span>
                        <Input value={form.asset_code} onChange={(event) => update("asset_code", event.target.value)} placeholder="ASSET-001" disabled={mode === "edit"} />
                        {errors.asset_code && <span className="text-xs text-red-600">{errors.asset_code}</span>}
                    </label>
                    <label className="space-y-1 block">
                        <span className="text-sm font-medium text-slate-700">Loại tài sản *</span>
                        <select
                            value={form.feature_type}
                            onChange={(event) => update("feature_type", event.target.value)}
                            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
                        >
                            {FEATURE_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                        </select>
                        {errors.feature_type && <span className="text-xs text-red-600">{errors.feature_type}</span>}
                    </label>
                    <label className="space-y-1 block">
                        <span className="text-sm font-medium text-slate-700">Mã loại hình *</span>
                        <Input value={form.feature_code} onChange={(event) => update("feature_code", event.target.value)} placeholder="den_duong" />
                        {errors.feature_code && <span className="text-xs text-red-600">{errors.feature_code}</span>}
                    </label>
                    <label className="space-y-1 block">
                        <span className="text-sm font-medium text-slate-700">Danh mục</span>
                        <Input value={form.category} onChange={(event) => update("category", event.target.value)} placeholder="lighting" />
                    </label>
                    <label className="space-y-1 block">
                        <span className="text-sm font-medium text-slate-700">Trạng thái</span>
                        <select value={form.status} onChange={(event) => update("status", event.target.value)} className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm">
                            {STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
                        </select>
                    </label>
                    <label className="space-y-1 block">
                        <span className="text-sm font-medium text-slate-700">Tình trạng</span>
                        <select value={form.condition} onChange={(event) => update("condition", event.target.value)} className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm">
                            {CONDITIONS.map((condition) => <option key={condition} value={condition}>{condition}</option>)}
                        </select>
                    </label>
                    <label className="space-y-1 block">
                        <span className="text-sm font-medium text-slate-700">Vòng đời</span>
                        <select value={form.lifecycle_stage} onChange={(event) => update("lifecycle_stage", event.target.value)} className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm">
                            {LIFECYCLE_STAGES.map((stage) => <option key={stage} value={stage}>{stage}</option>)}
                        </select>
                    </label>
                    <label className="space-y-1 block">
                        <span className="text-sm font-medium text-slate-700">Kinh độ (lng)</span>
                        <Input value={form.longitude} onChange={(event) => update("longitude", event.target.value)} placeholder="105.8342" inputMode="decimal" />
                        {errors.longitude && <span className="text-xs text-red-600">{errors.longitude}</span>}
                    </label>
                    <label className="space-y-1 block">
                        <span className="text-sm font-medium text-slate-700">Vĩ độ (lat)</span>
                        <Input value={form.latitude} onChange={(event) => update("latitude", event.target.value)} placeholder="21.0278" inputMode="decimal" />
                        {errors.latitude && <span className="text-xs text-red-600">{errors.latitude}</span>}
                    </label>
                    <label className="space-y-1 block">
                        <span className="text-sm font-medium text-slate-700">Địa chỉ</span>
                        <Input value={form.address} onChange={(event) => update("address", event.target.value)} placeholder="Số 1 Nguyễn Huệ" />
                    </label>
                    <label className="space-y-1 block">
                        <span className="text-sm font-medium text-slate-700">Đơn vị quản lý</span>
                        <Input value={form.owner} onChange={(event) => update("owner", event.target.value)} placeholder="Trung tâm hạ tầng" />
                    </label>
                </div>

                {mutation.error && (
                    <p className="text-sm text-red-600" role="alert">
                        {(mutation.error as Error).message}
                    </p>
                )}
                {submitted && Object.keys(errors).length > 0 && (
                    <p className="text-sm text-red-600" role="alert">Vui lòng sửa các trường được đánh dấu.</p>
                )}

                <div className="flex gap-2">
                    <Button type="submit" disabled={mutation.isPending}>
                        <Save className="h-4 w-4 mr-2" />
                        {mutation.isPending ? "Đang lưu..." : "Lưu tài sản"}
                    </Button>
                    <Button type="button" variant="outline" onClick={() => navigate({ to: "/admin/assets" })}>
                        Hủy
                    </Button>
                </div>
            </form>
        </div>
    );
}

export default function AssetForm({ mode }: AssetFormProps) {
    const params = useParams({ strict: false }) as { id?: string };
    const assetId = mode === "edit" ? String(params.id || "") : "";

    const { data: existing, isLoading } = useQuery({
        queryKey: ["asset", assetId],
        queryFn: () => assetsApi.getById(assetId),
        enabled: mode === "edit" && !!assetId,
    });

    if (mode === "edit" && isLoading) {
        return (
            <div className="p-6 space-y-6">
                <Skeleton className="h-12 w-64" />
                <Skeleton className="h-96 w-full" />
            </div>
        );
    }

    return (
        <AssetFormBody
            key={mode === "edit" ? assetId : "create"}
            mode={mode}
            assetId={assetId}
            initial={mode === "edit" ? formFromAsset(existing) : EMPTY}
        />
    );
}
