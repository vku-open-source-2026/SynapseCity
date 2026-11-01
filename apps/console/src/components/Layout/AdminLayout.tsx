// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { Outlet } from "@tanstack/react-router";
import Sidebar from "../Sidebar";

export const AdminLayout: React.FC = () => {
    return (
        <div className="flex h-screen bg-slate-50 font-sans text-slate-900">
            <Sidebar />
            <main className="flex-1 flex flex-col overflow-y-auto lg:ml-0">
                <Outlet />
            </main>
        </div>
    );
};
