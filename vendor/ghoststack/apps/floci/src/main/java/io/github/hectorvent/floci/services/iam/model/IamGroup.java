package io.github.hectorvent.floci.services.iam.model;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import io.quarkus.runtime.annotations.RegisterForReflection;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

@RegisterForReflection
@JsonIgnoreProperties(ignoreUnknown = true)
public class IamGroup {

    private String groupId;
    private String groupName;
    private String path;
    private String arn;
    private Instant createDate;
    private List<String> userNames = new ArrayList<>();
    private List<String> attachedPolicyArns = new ArrayList<>();
    private Map<String, String> inlinePolicies = new HashMap<>();

    public IamGroup() {}

    public IamGroup(String groupId, String groupName, String path, String arn) {
        this.groupId = groupId;
        this.groupName = groupName;
        this.path = path;
        this.arn = arn;
        this.createDate = Instant.now();
    }

    public String getGroupId() { return groupId; }
    public void setGroupId(String groupId) { this.groupId = groupId; }

    public String getGroupName() { return groupName; }
    public void setGroupName(String groupName) { this.groupName = groupName; }

    public String getPath() { return path; }
    public void setPath(String path) { this.path = path; }

    public String getArn() { return arn; }
    public void setArn(String arn) { this.arn = arn; }

    public Instant getCreateDate() { return createDate; }
    public void setCreateDate(Instant createDate) { this.createDate = createDate; }

    public List<String> getUserNames() { return userNames; }
    public void setUserNames(List<String> userNames) { this.userNames = userNames; }

    public List<String> getAttachedPolicyArns() { return attachedPolicyArns; }
    public void setAttachedPolicyArns(List<String> attachedPolicyArns) { this.attachedPolicyArns = attachedPolicyArns; }

    public Map<String, String> getInlinePolicies() { return inlinePolicies; }
    public void setInlinePolicies(Map<String, String> inlinePolicies) { this.inlinePolicies = inlinePolicies; }
}
