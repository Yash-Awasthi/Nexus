package io.github.hectorvent.floci.core.common;

import jakarta.enterprise.context.RequestScoped;

/**
 * Holds per-request derived values — account ID and region — extracted from the
 * incoming AWS credential and Authorization header. Populated by
 * {@link AccountContextFilter} before any handler runs.
 */
@RequestScoped
public class RequestContext {

    private String accountId;
    private String region;

    public String getAccountId() {
        return accountId;
    }

    public void setAccountId(String accountId) {
        this.accountId = accountId;
    }

    public String getRegion() {
        return region;
    }

    public void setRegion(String region) {
        this.region = region;
    }
}
