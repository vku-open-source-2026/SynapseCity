// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * External links shown on the public website: source, releases, build guide,
 * dependency licences, changelog, bug tracker and partner sites.
 */
const REPO = "https://github.com/vku-open-source-2026/SynapseCity";

export const LINKS = {
    repo: REPO,
    releases: `${REPO}/releases`,
    changelog: `${REPO}/blob/main/CHANGELOG.md`,
    buildFromSource: `${REPO}#run`,
    thirdParty: `${REPO}/blob/main/THIRD-PARTY.md`,
    issues: `${REPO}/issues`,
    contributing: `${REPO}/blob/main/CONTRIBUTING.md`,
    sourceLicense: `${REPO}/blob/main/LICENSE`,
    apacheLicense: "https://www.apache.org/licenses/LICENSE-2.0",
    dataLicense: "https://opendatacommons.org/licenses/pddl/1-0/",
    basemap: "https://vietmap.vn/",
    dataContribution: "https://contribution.synapsecity.sbs/",
    sos: "https://sos.synapsecity.sbs/",
    androidApk: "https://synapsedx.sbs/v1/capabilities/public/files/synapsecity-android-0.1.0-arm64-x86_64/content",
    synapseDX: "https://synapsedx.sbs/",
    synapseOne: "https://synapseone.space/",
    vku: "https://vku.udn.vn",
    vic: "https://www.facebook.com/vic.club.vku?locale=vi_VN",
} as const;
