package io.github.hectorvent.floci.services.apigateway.model;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import io.quarkus.runtime.annotations.RegisterForReflection;

import java.util.ArrayList;
import java.util.List;

@RegisterForReflection
@JsonIgnoreProperties(ignoreUnknown = true)
public class UsagePlan {
    private String id;
    private String name;
    private String description;
    private List<ApiStage> apiStages = new ArrayList<>();

    public UsagePlan() {}

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }

    public String getDescription() { return description; }
    public void setDescription(String description) { this.description = description; }

    public List<ApiStage> getApiStages() { return apiStages; }
    public void setApiStages(List<ApiStage> apiStages) { this.apiStages = apiStages; }

    @RegisterForReflection
    public record ApiStage(String apiId, String stage) {}
}
