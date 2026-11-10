// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
package sbs.synapsecity.mobile.widget

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent

class CityWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray,
    ) {
        appWidgetIds.forEach { CityWidgetRenderer.render(context, it) }
        CityWidgetWorker.schedulePeriodic(context)
        if (WidgetStore.load(context) == null) {
            CityWidgetWorker.enqueueOneTime(context)
        }
    }

    override fun onEnabled(context: Context) {
        super.onEnabled(context)
        CityWidgetWorker.schedulePeriodic(context)
        CityWidgetWorker.enqueueOneTime(context)
    }

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        if (intent.action == ACTION_REFRESH) {
            CityWidgetWorker.enqueueOneTime(context)
            val id = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, -1)
            if (id != -1) CityWidgetRenderer.render(context, id)
        }
    }

    companion object {
        const val ACTION_REFRESH = "sbs.synapsecity.mobile.widget.REFRESH"

        fun updateAll(context: Context) {
            CityWidgetRenderer.updateAll(context)
        }
    }
}
