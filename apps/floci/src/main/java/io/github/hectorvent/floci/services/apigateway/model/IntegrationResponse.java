package io.github.hectorvent.floci.services.apigateway.model;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

import java.util.Map;

@JsonIgnoreProperties(ignoreUnknown = true)
public record IntegrationResponse(
        String statusCode,
        String selectionPattern,
        Map<String, String> responseParameters,
        Map<String, String> responseTemplates
) {}
