// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC

/**
 * SynapseCity app-icon tile: royal-blue tile + the city-blocks mark.
 * The tile keeps the mark legible on both light and dark console chrome.
 */
export function BrandSymbol({ className = "h-9 w-9" }: { className?: string }) {
    return (
        <svg viewBox="0 0 256 256" className={className} aria-hidden="true">
            <rect width="256" height="256" rx="56" fill="#1D4ED8" />
            <g transform="translate(51.2 51.2) scale(0.6)">
                <rect x="22" y="22" width="120" height="120" rx="30" fill="#FFFFFF" />
                <rect x="158" y="22" width="76" height="76" rx="20" fill="#FFFFFF" />
                <rect x="22" y="158" width="76" height="76" rx="20" fill="#FFFFFF" />
                <rect x="176" y="176" width="40" height="40" rx="12" fill="#BFDBFE" />
            </g>
        </svg>
    );
}
