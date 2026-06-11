package io.github.hectorvent.floci.core.common;

import jakarta.ws.rs.container.ContainerRequestContext;
import jakarta.ws.rs.container.ContainerResponseContext;
import jakarta.ws.rs.container.ContainerResponseFilter;
import jakarta.ws.rs.ext.Provider;

import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.Locale;

/**
 * Sets the Date response header in RFC 822 format as expected by AWS SDKs.
 * Without this, Quarkus/Vert.x may send ISO 8601 format which the SDK cannot parse.
 */
@Provider
public class AwsDateHeaderFilter implements ContainerResponseFilter {

    private static final ZoneId GMT = ZoneId.of("GMT");
    private static final DateTimeFormatter RFC_822 = DateTimeFormatter
            .ofPattern("EEE, dd MMM yyyy HH:mm:ss z", Locale.US);

    @Override
    public void filter(ContainerRequestContext requestContext, ContainerResponseContext responseContext) {
        responseContext.getHeaders().putSingle("Date",
                ZonedDateTime.now(GMT).format(RFC_822));
    }
}
