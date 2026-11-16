// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import type { Messages } from "../locales/vi";
import { useI18n } from "../lib/i18n-context";

/**
 * Text whose box is as wide as its longest translation, so switching VI/EN
 * never moves neighbouring header buttons under the pointer.
 */
export function StableLabel({ pick }: { pick: (m: Messages) => string }) {
    const { m, dicts } = useI18n();
    return (
        <span className="inline-grid whitespace-nowrap">
            {Object.entries(dicts).map(([lang, dict]) => (
                <span key={lang} aria-hidden="true" className="invisible col-start-1 row-start-1">
                    {pick(dict)}
                </span>
            ))}
            <span className="col-start-1 row-start-1 text-center">{pick(m)}</span>
        </span>
    );
}
