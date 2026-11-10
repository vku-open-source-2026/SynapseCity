// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
package sbs.synapsecity.mobile.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Shader
import android.net.Uri
import android.widget.RemoteViews
import androidx.core.content.ContextCompat
import sbs.synapsecity.mobile.MainActivity
import sbs.synapsecity.mobile.R
import java.util.concurrent.TimeUnit
import kotlin.math.cos
import kotlin.math.min

object CityWidgetRenderer {
    fun render(context: Context, appWidgetId: Int) {
        val snapshot = WidgetStore.load(context)
        val views = RemoteViews(context.packageName, R.layout.city_widget)
        val generated = snapshot?.generatedAt ?: 0L
        val ageMinutes = if (generated > 0) {
            TimeUnit.MILLISECONDS.toMinutes(System.currentTimeMillis() - generated).coerceAtLeast(0)
        } else {
            Long.MAX_VALUE
        }
        val stale = snapshot == null || !snapshot.online || ageMinutes > 30

        views.setTextViewText(R.id.widget_location, context.getString(R.string.widget_location_default))
        views.setTextViewText(R.id.widget_nearest_name, context.getString(R.string.widget_no_data))
        views.setTextViewText(R.id.widget_nearest_meta, context.getString(R.string.widget_no_data_hint))
        views.setTextViewText(R.id.widget_second_name, "")
        views.setTextViewText(R.id.widget_footer, context.getString(R.string.widget_waiting))

        if (snapshot != null) {
            val locationLabel = if (snapshot.locationIsFallback) {
                context.getString(R.string.widget_location_default)
            } else {
                context.getString(R.string.widget_location_gps)
            }
            views.setTextViewText(R.id.widget_location, locationLabel)
            views.setTextViewText(
                R.id.widget_nearest_name,
                snapshot.nearestName ?: context.getString(R.string.widget_no_nearby),
            )
            val distance = snapshot.nearestDistanceM?.let { formatDistance(it) }
            val status = statusLabel(snapshot.nearestStatus)
            val meta = if (distance != null) {
                if (stale) "$distance · $status · ${context.getString(R.string.widget_stale)}" else "$distance · $status"
            } else {
                context.getString(R.string.widget_no_nearby)
            }
            views.setTextViewText(R.id.widget_nearest_meta, meta)
            val second = snapshot.assets.getOrNull(1)
            views.setTextViewText(
                R.id.widget_second_name,
                second?.let { "${it.name} · ${formatDistance(it.distanceM)}" } ?: "",
            )
            views.setTextViewText(
                R.id.widget_footer,
                if (stale) {
                    val age = if (ageMinutes == Long.MAX_VALUE) {
                        context.getString(R.string.widget_never)
                    } else {
                        context.getString(R.string.widget_ago, ageMinutes)
                    }
                    context.getString(R.string.widget_stale_footer, age)
                } else {
                    context.getString(R.string.widget_updated, ageMinutes)
                },
            )
            val statusColor = if (stale) "#D97706" else when (snapshot.nearestStatus) {
                "active" -> "#059669"
                "maintenance" -> "#D97706"
                "inactive" -> "#64748B"
                "decommissioned" -> "#DC2626"
                else -> "#059669"
            }
            views.setTextColor(R.id.widget_status_dot, Color.parseColor(statusColor))
            views.setTextViewText(R.id.widget_status_dot, "●")
            views.setTextViewText(R.id.widget_brand, context.getString(R.string.widget_brand))

            val code = snapshot.nearestCode
            if (code != null) {
                views.setOnClickPendingIntent(
                    R.id.widget_root,
                    openApp(context, "synapsecity://asset/${Uri.encode(code)}", appWidgetId * 10 + 1),
                )
                views.setOnClickPendingIntent(
                    R.id.widget_map,
                    openApp(context, "synapsecity://asset/${Uri.encode(code)}", appWidgetId * 10 + 2),
                )
            } else {
                views.setOnClickPendingIntent(
                    R.id.widget_root,
                    openApp(context, "synapsecity://map", appWidgetId * 10 + 1),
                )
            }
        } else {
            views.setTextColor(R.id.widget_status_dot, Color.parseColor("#FBBF24"))
            views.setTextViewText(R.id.widget_status_dot, "●")
            views.setOnClickPendingIntent(
                R.id.widget_root,
                openApp(context, "synapsecity://", appWidgetId * 10 + 1),
            )
        }

        views.setImageViewBitmap(R.id.widget_map, drawMap(context, snapshot))
        views.setOnClickPendingIntent(
            R.id.widget_scan,
            openApp(context, "synapsecity://scan", appWidgetId * 10 + 3),
        )
        views.setOnClickPendingIntent(
            R.id.widget_refresh,
            refreshIntent(context, appWidgetId),
        )
        appWidgetManager(context).updateAppWidget(appWidgetId, views)
    }

    fun updateAll(context: Context) {
        val manager = appWidgetManager(context)
        val component = ComponentName(context, CityWidgetProvider::class.java)
        val ids = manager.getAppWidgetIds(component)
        ids.forEach { render(context, it) }
    }

    private fun appWidgetManager(context: Context): AppWidgetManager =
        AppWidgetManager.getInstance(context)

    private fun openApp(context: Context, uri: String, requestCode: Int): PendingIntent {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(uri), context, MainActivity::class.java)
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        return PendingIntent.getActivity(
            context,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun refreshIntent(context: Context, appWidgetId: Int): PendingIntent {
        val intent = Intent(context, CityWidgetProvider::class.java).apply {
            action = CityWidgetProvider.ACTION_REFRESH
            putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId)
        }
        return PendingIntent.getBroadcast(
            context,
            appWidgetId * 10 + 4,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun statusLabel(status: String?): String = when (status) {
        "active" -> "Đang hoạt động"
        "maintenance" -> "Đang bảo trì"
        "inactive" -> "Tạm ngưng"
        "decommissioned" -> "Đã ngừng"
        else -> "Chưa rõ trạng thái"
    }

    private fun formatDistance(meters: Int): String =
        if (meters < 950) "${(meters / 10) * 10} m" else String.format("%.1f km", meters / 1000.0)

    private fun drawMap(context: Context, snapshot: CityWidgetSnapshot?): Bitmap {
        val size = 320
        val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        val radius = size / 2f
        val clip = Path().apply {
            addRoundRect(RectF(0f, 0f, size.toFloat(), size.toFloat()), 28f, 28f, Path.Direction.CW)
        }
        canvas.clipPath(clip)

        val bg = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            shader = LinearGradient(
                0f, 0f, size.toFloat(), size.toFloat(),
                Color.parseColor("#ECFEFF"),
                Color.parseColor("#FFFFFF"),
                Shader.TileMode.CLAMP,
            )
        }
        canvas.drawRect(0f, 0f, size.toFloat(), size.toFloat(), bg)

        val center = size / 2f
        val ringPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            strokeWidth = 2f
            color = Color.argb(55, 15, 159, 154)
        }
        canvas.drawCircle(center, center, size * 0.46f, ringPaint)
        canvas.drawCircle(center, center, size * 0.30f, ringPaint)
        canvas.drawCircle(center, center, size * 0.15f, ringPaint)

        val axisPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.argb(80, 217, 232, 234)
            strokeWidth = 1.5f
        }
        canvas.drawLine(center, size * 0.05f, center, size * 0.95f, axisPaint)
        canvas.drawLine(size * 0.05f, center, size * 0.95f, center, axisPaint)

        val lat = snapshot?.latitude ?: CityWidgetWorker.DEFAULT_LAT
        val lng = snapshot?.longitude ?: CityWidgetWorker.DEFAULT_LNG
        val maxRadiusPx = size * 0.44f
        val metersPerDegLat = 111_320.0
        val metersPerDegLng = metersPerDegLat * cos(Math.toRadians(lat))
        val assets = snapshot?.assets ?: emptyList()
        assets.forEach { asset ->
            val dx = (asset.longitude - lng) * metersPerDegLng
            val dy = -(asset.latitude - lat) * metersPerDegLat
            val distance = kotlin.math.sqrt(dx * dx + dy * dy)
            if (distance > 5_000) return@forEach
            val scale = maxRadiusPx / 5_000.0
            val x = center + (dx * scale).toFloat()
            val y = center + (dy * scale).toFloat()
            val dot = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                color = Color.parseColor(statusColor(asset.status))
                style = Paint.Style.FILL
            }
            canvas.drawCircle(x, y, if (asset.code == snapshot?.nearestCode) 9f else 6f, dot)
            val outline = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                color = Color.parseColor("#FFFFFF")
                style = Paint.Style.STROKE
                strokeWidth = 2f
            }
            canvas.drawCircle(x, y, if (asset.code == snapshot?.nearestCode) 9f else 6f, outline)
        }

        val halo = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(45, 14, 116, 144) }
        canvas.drawCircle(center, center, 19f, halo)
        val user = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.parseColor("#0E7490") }
        canvas.drawCircle(center, center, 10f, user)
        val userOutline = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.parseColor("#FFFFFF")
            style = Paint.Style.STROKE
            strokeWidth = 3f
        }
        canvas.drawCircle(center, center, 10f, userOutline)

        val text = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.parseColor("#64748B")
            textSize = 18f
            isFakeBoldText = true
        }
        canvas.drawText("B", center - 6f, 24f, text)
        canvas.drawText(
            if (snapshot?.locationIsFallback == false) "GPS" else "ĐN",
            14f,
            size - 14f,
            text,
        )
        canvas.drawText("5 km", size - 58f, size - 14f, text)

        return bitmap
    }

    private fun statusColor(status: String): String = when (status) {
        "active" -> "#059669"
        "maintenance" -> "#D97706"
        "inactive" -> "#64748B"
        "decommissioned" -> "#DC2626"
        else -> "#64748B"
    }
}
