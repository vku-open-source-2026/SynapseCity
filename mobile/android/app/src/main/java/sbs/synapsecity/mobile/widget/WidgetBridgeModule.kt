// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
package sbs.synapsecity.mobile.widget

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class WidgetBridgeModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "WidgetBridge"

    @ReactMethod
    fun sync(snapshotJson: String) {
        val snapshot = WidgetStore.saveRaw(reactApplicationContext, snapshotJson) ?: return
        CityWidgetProvider.updateAll(reactApplicationContext)
        if (!snapshot.online) {
            CityWidgetWorker.enqueueOneTime(reactApplicationContext)
        }
    }

    @ReactMethod
    fun refresh() {
        CityWidgetWorker.enqueueOneTime(reactApplicationContext)
    }
}
