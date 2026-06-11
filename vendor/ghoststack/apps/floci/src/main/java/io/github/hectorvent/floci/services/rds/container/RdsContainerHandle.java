package io.github.hectorvent.floci.services.rds.container;

import java.io.Closeable;

/**
 * Wraps a running backend Docker container for an RDS DB instance or cluster.
 */
public class RdsContainerHandle {

    private final String containerId;
    private final String instanceId;
    private final String host;
    private final int port;
    private Closeable logStream;

    public RdsContainerHandle(String containerId, String instanceId, String host, int port) {
        this.containerId = containerId;
        this.instanceId = instanceId;
        this.host = host;
        this.port = port;
    }

    public String getContainerId() { return containerId; }
    public String getInstanceId() { return instanceId; }
    public String getHost() { return host; }
    public int getPort() { return port; }
    public Closeable getLogStream() { return logStream; }
    public void setLogStream(Closeable logStream) { this.logStream = logStream; }
}
