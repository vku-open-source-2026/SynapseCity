// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Process-isolated environment tests for both dependency URL settings.

use contribution_backend::config::{Config, StorageBackend};

fn set(key: &str, value: &str) {
    std::env::set_var(key, value);
}

#[test]
fn production_configuration_validates_tier2_and_legacy_urls_before_use() {
    set("ENVIRONMENT", "production");
    set("JWT_SECRET_KEY", "0123456789abcdef0123456789abcdef");
    set("ADMIN_PASSWORD", "test-password-123");
    set("STORAGE_BACKEND", "dx");
    set("SYNAPSEDX_API_KEY", "test-tier2-key");
    set("SYNAPSEDX_TOKEN", "");
    set("SYNAPSEONE_API_KEY", "test-legacy-key");
    set("ALLOW_LOCAL_DEPENDENCIES", "false");
    set("SYNAPSEDX_BASE_URL", "https://synapsedx.sbs");
    set("SYNAPSEONE_BASE_URL", "https://api.synapseone.space");

    set("SYNAPSEDX_BASE_URL", "https://user:pass@synapsedx.sbs");
    assert!(Config::from_env()
        .unwrap_err()
        .to_string()
        .contains("credentials"));

    set("SYNAPSEDX_BASE_URL", "https://[fc00::1]");
    assert!(Config::from_env()
        .unwrap_err()
        .to_string()
        .contains("private host"));

    set("SYNAPSEDX_BASE_URL", "https://synapsedx.sbs");
    set("SYNAPSEONE_BASE_URL", "http://10.0.0.1");
    assert!(Config::from_env()
        .unwrap_err()
        .to_string()
        .contains("private host"));

    set("SYNAPSEONE_BASE_URL", "https://user@api.synapseone.space");
    assert!(Config::from_env()
        .unwrap_err()
        .to_string()
        .contains("credentials"));

    set("SYNAPSEONE_BASE_URL", "https://api.synapseone.space");
    set("ALLOW_LOCAL_DEPENDENCIES", "true");
    assert!(Config::from_env()
        .unwrap_err()
        .to_string()
        .contains("refused in production"));

    set("ALLOW_LOCAL_DEPENDENCIES", "false");
    let config = Config::from_env().unwrap();
    assert_eq!(config.storage_backend, StorageBackend::Dx);
    assert_eq!(config.synapsedx_base_url, "https://synapsedx.sbs");
    assert_eq!(config.synapseone_base_url, "https://api.synapseone.space");
}
