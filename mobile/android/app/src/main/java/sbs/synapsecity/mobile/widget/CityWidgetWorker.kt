// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
package sbs.synapsecity.mobile.widget

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.TimeUnit
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt
import org.json.JSONArray
import org.json.JSONObject

class CityWidgetWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        val previous = WidgetStore.load(applicationContext)
        val latitude = previous?.latitude ?: DEFAULT_LAT
        val longitude = previous?.longitude ?: DEFAULT_LNG
        val locationLabel = previous?.locationLabel ?: "Đà Nẵng · mặc định"
        val isFallback = previous?.locationIsFallback ?: true

        return try {
            val body = fetchAssets()
            val rows = JSONArray(body)
            val nearby = ArrayList<WidgetAsset>()
            var nearest: WidgetAsset? = null
            var nearestDistance = Double.MAX_VALUE

            for (index in 0 until rows.length()) {
                val item = rows.optJSONObject(index) ?: continue
                val coordinates = coordinatesOf(item) ?: continue
                val distance = distanceMeters(latitude, longitude, coordinates.first, coordinates.second)
                if (distance > NEARBY_RADIUS_M) continue
                val asset = WidgetAsset(
                    code = item.optString("asset_code"),
                    name = item.optString("name", "Tài sản hạ tầng"),
                    status = item.optString("status", "active"),
                    distanceM = distance.toInt(),
                    latitude = coordinates.first,
                    longitude = coordinates.second,
                )
                nearby.add(asset)
                if (distance < nearestDistance) {
                    nearest = asset
                    nearestDistance = distance
                }
            }
            nearby.sortBy { it.distanceM }

            val snapshot = CityWidgetSnapshot(
                generatedAt = System.currentTimeMillis(),
                source = "background",
                latitude = latitude,
                longitude = longitude,
                locationLabel = locationLabel,
                locationIsFallback = isFallback,
                nearestCode = nearest?.code,
                nearestName = nearest?.name,
                nearestDistanceM = nearest?.distanceM,
                nearestStatus = nearest?.status,
                totalNearby = nearby.size,
                assets = nearby.take(12),
                online = true,
            )
            WidgetStore.save(applicationContext, snapshot)
            CityWidgetProvider.updateAll(applicationContext)
            Result.success()
        } catch (_: Exception) {
            WidgetStore.markOffline(applicationContext)
            CityWidgetProvider.updateAll(applicationContext)
            Result.success()
        }
    }

    private fun fetchAssets(): String {
        val connection = URL(ASSETS_URL).openConnection() as HttpURLConnection
        return try {
            connection.requestMethod = "GET"
            connection.connectTimeout = 15_000
            connection.readTimeout = 20_000
            connection.instanceFollowRedirects = true
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("User-Agent", "SynapseCityWidget/0.1 (Android)")
            val code = connection.responseCode
            if (code !in 200..299) error("HTTP $code")
            connection.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
        } finally {
            connection.disconnect()
        }
    }

    private fun coordinatesOf(item: JSONObject): Pair<Double, Double>? {
        val location = item.optJSONObject("location")
        val coordinates = location?.optJSONObject("coordinates")
        val lat = coordinates?.optDouble("latitude", Double.NaN) ?: Double.NaN
        val lng = coordinates?.optDouble("longitude", Double.NaN) ?: Double.NaN
        if (!lat.isNaN() && !lng.isNaN()) return lat to lng

        val geometryCoordinates = location?.optJSONObject("geometry")?.optJSONArray("coordinates")
            ?: item.optJSONObject("geometry")?.optJSONArray("coordinates")
            ?: return null
        if (geometryCoordinates.length() < 2) return null
        return geometryCoordinates.optDouble(1) to geometryCoordinates.optDouble(0)
    }

    private fun distanceMeters(lat1: Double, lng1: Double, lat2: Double, lng2: Double): Double {
        val earth = 6_371_000.0
        val dLat = Math.toRadians(lat2 - lat1)
        val dLng = Math.toRadians(lng2 - lng1)
        val a = sin(dLat / 2) * sin(dLat / 2) +
            cos(Math.toRadians(lat1)) * cos(Math.toRadians(lat2)) *
            sin(dLng / 2) * sin(dLng / 2)
        return 2 * earth * atan2(sqrt(a), sqrt(1 - a))
    }

    companion object {
        const val DEFAULT_LAT = 16.0544
        const val DEFAULT_LNG = 108.2022
        private const val NEARBY_RADIUS_M = 5_000.0
        private const val ASSETS_URL = "https://synapsecity.sbs/v1/public/assets?limit=200"
        private const val PERIODIC_NAME = "city-widget-periodic"
        private const val ONE_TIME_NAME = "city-widget-refresh"

        fun schedulePeriodic(context: Context) {
            val constraints = Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()
            val request = PeriodicWorkRequestBuilder<CityWidgetWorker>(30, TimeUnit.MINUTES)
                .setConstraints(constraints)
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                PERIODIC_NAME,
                ExistingPeriodicWorkPolicy.UPDATE,
                request,
            )
        }

        fun enqueueOneTime(context: Context) {
            // No network constraint: an offline refresh must still run so the
            // widget can mark its cached snapshot as stale instead of silently
            // doing nothing.
            val request = OneTimeWorkRequestBuilder<CityWidgetWorker>()
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(
                ONE_TIME_NAME,
                ExistingWorkPolicy.REPLACE,
                request,
            )
        }
    }
}
