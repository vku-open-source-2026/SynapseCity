// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ThemeContext, type ThemeChoice } from "./theme-context";

const STORAGE_KEY = "synapsecity.theme";
const ORDER: ThemeChoice[] = ["light", "dark", "system"];

function readChoice(): ThemeChoice {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved === "light" || saved === "dark" || saved === "system") return saved;
    } catch {
        /* storage blocked: fall back to the OS preference */
    }
    return "system";
}

function systemPrefersDark(): boolean {
    return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches;
}

/** Mirrors the inline script in index.html so the first paint already has the right theme. */
function apply(choice: ThemeChoice) {
    const dark = choice === "dark" || (choice === "system" && systemPrefersDark());
    const root = document.documentElement;
    root.classList.toggle("dark", dark);
    root.style.colorScheme = dark ? "dark" : "light";
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#0b1220" : "#ffffff");
}

export function ThemeProvider({ children }: { children: ReactNode }) {
    const [choice, setChoiceState] = useState<ThemeChoice>(readChoice);

    useEffect(() => {
        apply(choice);
        if (choice !== "system") return;
        const media = window.matchMedia("(prefers-color-scheme: dark)");
        const onChange = () => apply("system");
        media.addEventListener("change", onChange);
        return () => media.removeEventListener("change", onChange);
    }, [choice]);

    const setChoice = useCallback((next: ThemeChoice) => {
        setChoiceState(next);
        try {
            localStorage.setItem(STORAGE_KEY, next);
        } catch {
            /* ignore */
        }
    }, []);

    const cycle = useCallback(() => {
        setChoice(ORDER[(ORDER.indexOf(choice) + 1) % ORDER.length]);
    }, [choice, setChoice]);

    const value = useMemo(() => ({ choice, setChoice, cycle }), [choice, setChoice, cycle]);
    return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
