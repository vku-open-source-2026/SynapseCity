// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
package sbs.synapsecity.mobile.widget

import android.content.Context

object WidgetStore {
    private const val PREFS = "synapsecity_widget"
    private const val KEY_SNAPSHOT = "snapshot"

    fun load(context: Context): CityWidgetSnapshot? {
        val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_SNAPSHOT, null)
        return CityWidgetSnapshot.fromJson(raw)
    }

    fun save(context: Context, snapshot: CityWidgetSnapshot) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_SNAPSHOT, snapshot.toJson())
            .apply()
    }

    fun saveRaw(context: Context, raw: String): CityWidgetSnapshot? {
        val parsed = CityWidgetSnapshot.fromJson(raw) ?: return null
        save(context, parsed)
        return parsed
    }

    fun markOffline(context: Context): CityWidgetSnapshot? {
        val current = load(context) ?: return null
        val offline = current.copy(online = false)
        save(context, offline)
        return offline
    }
}
