// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
package sbs.synapsecity.mobile.widget

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class WidgetAssetPaginatorTest {
    @Test
    fun keepsAssetsBeyondTheFirstPageSoTheNearestCanBeFound() {
        val assets = (0 until 201).map { index ->
            Asset(distanceMeters = if (index == 200) 10 else 10_000 + index)
        }
        val requestedOffsets = mutableListOf<Int>()

        val result = WidgetAssetPaginator.fetchAll { offset ->
            requestedOffsets.add(offset)
            WidgetAssetPage(
                items = assets.drop(offset).take(200),
                totalCount = assets.size.toLong(),
            )
        }

        assertEquals(listOf(0, 200), requestedOffsets)
        assertEquals(201, result.size)
        assertEquals(10, result.minByOrNull { it.distanceMeters }?.distanceMeters)
    }

    @Test
    fun pagesUntilAnEmptyResponseWhenTotalCountIsUnavailable() {
        val pages = listOf(
            WidgetAssetPage(items = (1..100).toList(), totalCount = null),
            WidgetAssetPage(items = listOf(101), totalCount = null),
            WidgetAssetPage(items = emptyList<Int>(), totalCount = null),
        )
        val requestedOffsets = mutableListOf<Int>()
        var pageIndex = 0

        val result = WidgetAssetPaginator.fetchAll { offset ->
            requestedOffsets.add(offset)
            pages[pageIndex++]
        }

        assertEquals(listOf(0, 100, 101), requestedOffsets)
        assertEquals((1..101).toList(), result)
    }

    @Test
    fun advancesByRowsReceivedWhenTheApiCapsThePageSize() {
        val requestedOffsets = mutableListOf<Int>()
        val result = WidgetAssetPaginator.fetchAll { offset ->
            requestedOffsets.add(offset)
            when (offset) {
                0 -> WidgetAssetPage(items = (1..100).toList(), totalCount = 101)
                100 -> WidgetAssetPage(items = listOf(101), totalCount = 101)
                else -> error("unexpected extra page at offset $offset")
            }
        }

        assertEquals(listOf(0, 100), requestedOffsets)
        assertTrue(result.size == 101)
    }

    private data class Asset(val distanceMeters: Int)
}
