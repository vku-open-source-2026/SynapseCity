// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createContext, useContext } from "react";

export type ThemeChoice = "light" | "dark" | "system";

export interface ThemeContextValue {
    choice: ThemeChoice;
    setChoice: (next: ThemeChoice) => void;
    cycle: () => void;
}

export const ThemeContext = createContext<ThemeContextValue | null>(null);

/** Current theme choice. Provided by <ThemeProvider> in src/lib/theme.tsx. */
export function useTheme(): ThemeContextValue {
    const ctx = useContext(ThemeContext);
    if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider>");
    return ctx;
}
