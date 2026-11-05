// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Public links shown on the website. The OLP 2026 rules ask every submission to
 * expose its source, release, build-from-source steps, dependency licences,
 * documentation, changelog, bug tracker and demo, so they live in one place.
 */
const REPO = "https://github.com/vku-open-source-2026/SynapseCity";

export const LINKS = {
    repo: REPO,
    releases: `${REPO}/releases`,
    changelog: `${REPO}/blob/main/CHANGELOG.md`,
    buildFromSource: `${REPO}#run`,
    demo: `${REPO}#olp-2026-demo`,
    thirdParty: `${REPO}/blob/main/THIRD-PARTY.md`,
    issues: `${REPO}/issues`,
    contributing: `${REPO}/blob/main/CONTRIBUTING.md`,
    sourceLicense: `${REPO}/blob/main/LICENSE`,
    apacheLicense: "https://www.apache.org/licenses/LICENSE-2.0",
    dataLicense: "https://creativecommons.org/publicdomain/zero/1.0/",
    osmCopyright: "https://www.openstreetmap.org/copyright",
    dataContribution: "https://contribution.synapsecity.sbs/",
    sos: "https://sos.synapsecity.sbs/",
    synapseDX: "https://synapsedx.sbs/",
    synapseOne: "https://synapseone.space/",
    vku: "https://vku.udn.vn",
    vic: "https://www.facebook.com/vaboratory",
} as const;
