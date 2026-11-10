// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
package sbs.synapsecity.mobile.widget

import org.json.JSONArray
import org.json.JSONObject

data class WidgetAsset(
    val code: String,
    val name: String,
    val status: String,
    val distanceM: Int,
    val latitude: Double,
    val longitude: Double,
)

data class CityWidgetSnapshot(
    val generatedAt: Long,
    val source: String,
    val latitude: Double,
    val longitude: Double,
    val locationLabel: String,
    val locationIsFallback: Boolean,
    val nearestCode: String?,
    val nearestName: String?,
    val nearestDistanceM: Int?,
    val nearestStatus: String?,
    val totalNearby: Int,
    val assets: List<WidgetAsset>,
    val online: Boolean,
) {
    fun toJson(): String {
        val root = JSONObject()
        root.put("generatedAt", generatedAt)
        root.put("source", source)
        root.put("latitude", latitude)
        root.put("longitude", longitude)
        root.put("locationLabel", locationLabel)
        root.put("locationIsFallback", locationIsFallback)
        root.put("nearestCode", nearestCode ?: JSONObject.NULL)
        root.put("nearestName", nearestName ?: JSONObject.NULL)
        root.put("nearestDistanceM", nearestDistanceM ?: JSONObject.NULL)
        root.put("nearestStatus", nearestStatus ?: JSONObject.NULL)
        root.put("totalNearby", totalNearby)
        root.put("online", online)
        val rows = JSONArray()
        assets.forEach { asset ->
            rows.put(
                JSONObject().apply {
                    put("code", asset.code)
                    put("name", asset.name)
                    put("status", asset.status)
                    put("distanceM", asset.distanceM)
                    put("latitude", asset.latitude)
                    put("longitude", asset.longitude)
                },
            )
        }
        root.put("assets", rows)
        return root.toString()
    }

    companion object {
        fun fromJson(raw: String?): CityWidgetSnapshot? {
            if (raw.isNullOrBlank()) return null
            return try {
                val root = JSONObject(raw)
                val rows = root.optJSONArray("assets") ?: JSONArray()
                val assets = buildList {
                    for (index in 0 until rows.length()) {
                        val item = rows.optJSONObject(index) ?: continue
                        add(
                            WidgetAsset(
                                code = item.optString("code"),
                                name = item.optString("name"),
                                status = item.optString("status"),
                                distanceM = item.optInt("distanceM"),
                                latitude = item.optDouble("latitude"),
                                longitude = item.optDouble("longitude"),
                            ),
                        )
                    }
                }
                CityWidgetSnapshot(
                    generatedAt = root.optLong("generatedAt"),
                    source = root.optString("source", "background"),
                    latitude = root.optDouble("latitude", 16.0544),
                    longitude = root.optDouble("longitude", 108.2022),
                    locationLabel = root.optString("locationLabel", "Đà Nẵng"),
                    locationIsFallback = root.optBoolean("locationIsFallback", true),
                    nearestCode = root.optString("nearestCode").takeIf { it.isNotBlank() && it != "null" },
                    nearestName = root.optString("nearestName").takeIf { it.isNotBlank() && it != "null" },
                    nearestDistanceM = root.optInt("nearestDistanceM", -1).takeIf { it >= 0 },
                    nearestStatus = root.optString("nearestStatus").takeIf { it.isNotBlank() && it != "null" },
                    totalNearby = root.optInt("totalNearby", assets.size),
                    assets = assets,
                    online = root.optBoolean("online", true),
                )
            } catch (_: Exception) {
                null
            }
        }
    }
}
