// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
package sbs.synapsecity.mobile.widget

internal data class WidgetAssetPage<T>(
    val items: List<T>,
    val totalCount: Long?,
)

/** Reads offset-based pages until an empty page or the reported total is reached. */
internal object WidgetAssetPaginator {
    fun <T> fetchAll(fetchPage: (offset: Int) -> WidgetAssetPage<T>): List<T> {
        val all = ArrayList<T>()
        var offset = 0
        var totalCount: Long? = null

        while (true) {
            val page = fetchPage(offset)
            if (page.items.isEmpty()) break
            all.addAll(page.items)
            // Advance by the rows actually received: the API may cap the requested page size.
            offset += page.items.size
            totalCount = page.totalCount ?: totalCount
            if (totalCount != null && offset >= totalCount) break
        }

        return all
    }
}
