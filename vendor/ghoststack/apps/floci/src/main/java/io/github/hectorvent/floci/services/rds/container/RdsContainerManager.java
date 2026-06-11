package io.github.hectorvent.floci.services.rds.container;

import io.github.hectorvent.floci.config.EmulatorConfig;
import io.github.hectorvent.floci.core.common.RegionResolver;
import io.github.hectorvent.floci.core.common.ServiceConfigAccess;
import io.github.hectorvent.floci.core.common.docker.ContainerBuilder;
import io.github.hectorvent.floci.core.common.docker.ContainerDetector;
import io.github.hectorvent.floci.core.common.docker.ContainerLifecycleManager;
import io.github.hectorvent.floci.core.common.docker.ContainerStorageHelper;
import io.github.hectorvent.floci.core.common.docker.ContainerLifecycleManager.ContainerInfo;
import io.github.hectorvent.floci.core.common.docker.ContainerLifecycleManager.EndpointInfo;
import io.github.hectorvent.floci.core.common.docker.ContainerLogStreamer;
import io.github.hectorvent.floci.core.common.docker.ContainerSpec;
import io.github.hectorvent.floci.services.rds.model.DatabaseEngine;
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.inject.Inject;
import org.jboss.logging.Logger;

import java.io.Closeable;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Manages backend Docker container lifecycle for RDS DB instances and clusters.
 * Starts postgres/mysql/mariadb containers and resolves the backend host:port for the auth proxy.
 */
@ApplicationScoped
public class RdsContainerManager {

    private static final Logger LOG = Logger.getLogger(RdsContainerManager.class);

    private final ContainerBuilder containerBuilder;
    private final ContainerLifecycleManager lifecycleManager;
    private final ContainerLogStreamer logStreamer;
    private final ContainerDetector containerDetector;
    private final EmulatorConfig config;
    private final RegionResolver regionResolver;
    private final ServiceConfigAccess serviceConfigAccess;
    private final Map<String, RdsContainerHandle> activeContainers = new ConcurrentHashMap<>();

    @Inject
    public RdsContainerManager(ContainerBuilder containerBuilder,
                               ContainerLifecycleManager lifecycleManager,
                               ContainerLogStreamer logStreamer,
                               ContainerDetector containerDetector,
                               EmulatorConfig config,
                               RegionResolver regionResolver,
                               ServiceConfigAccess serviceConfigAccess) {
        this.containerBuilder = containerBuilder;
        this.lifecycleManager = lifecycleManager;
        this.logStreamer = logStreamer;
        this.containerDetector = containerDetector;
        this.config = config;
        this.regionResolver = regionResolver;
        this.serviceConfigAccess = serviceConfigAccess;
    }

    public RdsContainerHandle start(String instanceId, String volumeId, DatabaseEngine engine,
                                    String image, String masterUsername,
                                    String masterPassword, String dbName) {
        LOG.infov("Starting RDS backend container for instance: {0} engine={1}", instanceId, engine);

        int enginePort = engine.defaultPort();
        String containerName = "floci-rds-" + instanceId;

        // Remove any stale container with the same name
        lifecycleManager.removeIfExists(containerName);

        // Build environment variables
        List<String> envVars = buildEnvVars(engine, masterUsername, masterPassword, dbName);

        // Build container spec with bind mounts for persistence. Publish the
        // engine port to the host only in native mode; in Docker mode the auth
        // proxy reaches the DB via the container network.
        ContainerBuilder.Builder specBuilder = containerBuilder.newContainer(image)
                .withName(containerName)
                .withEnv(envVars)
                .withDockerNetwork(config.services().rds().dockerNetwork())
                .withLogRotation();

        if (!containerDetector.isRunningInContainer()) {
            specBuilder.withDynamicPort(enginePort);
        } else {
            specBuilder.withExposedPort(enginePort);
        }

        // Handle persistence mounting
        addPersistenceMounts(specBuilder, instanceId, volumeId, engine, envVars);

        // Add engine-specific command
        List<String> cmd = buildContainerCmd(engine);
        if (!cmd.isEmpty()) {
            specBuilder.withCmd(cmd);
        }

        ContainerSpec spec = specBuilder.build();

        // Create and start container
        ContainerInfo info = lifecycleManager.createAndStart(spec);
        EndpointInfo endpoint = info.getEndpoint(enginePort);

        LOG.infov("RDS backend for instance {0}: {1}", instanceId, endpoint);

        RdsContainerHandle handle = new RdsContainerHandle(
                info.containerId(), instanceId, endpoint.host(), endpoint.port());
        activeContainers.put(instanceId, handle);

        // Attach log streaming
        String shortId = info.containerId().length() >= 8
                ? info.containerId().substring(0, 8)
                : info.containerId();
        String logGroup = "/aws/rds/instance/" + instanceId + "/error";
        String logStream = logStreamer.generateLogStreamName(shortId);
        String region = regionResolver.getDefaultRegion();

        Closeable logHandle = logStreamer.attach(
                info.containerId(), logGroup, logStream, region, "rds:" + instanceId);
        handle.setLogStream(logHandle);

        return handle;
    }

    public void stop(RdsContainerHandle handle) {
        if (handle == null) {
            return;
        }
        activeContainers.remove(handle.getInstanceId());
        lifecycleManager.stopAndRemove(handle.getContainerId(), handle.getLogStream());
    }

    public void stopAll() {
        List<RdsContainerHandle> handles = new ArrayList<>(activeContainers.values());
        if (!handles.isEmpty()) {
            LOG.infov("Stopping {0} RDS container(s) on shutdown", handles.size());
        }
        for (RdsContainerHandle handle : handles) {
            stop(handle);
        }
    }

    private void addPersistenceMounts(ContainerBuilder.Builder specBuilder, String instanceId,
                                      String volumeId, DatabaseEngine engine, List<String> envVars) {
        if (ContainerStorageHelper.isNamedVolumeMode(config)) {
            ContainerStorageHelper.applyStorage(
                    specBuilder, lifecycleManager, "rds", volumeId, instanceId,
                    engineDefaultDataPath(engine));
            return;
        }

        // Legacy host-path mode: host-persistent-path is an absolute path
        String hostDataPath = Path.of(config.storage().hostPersistentPath(), "rds", instanceId).toString();
        ContainerStorageHelper.ensureHostDir(hostDataPath);
        specBuilder.withBind(hostDataPath, engineDefaultDataPath(engine));
    }

    private static String engineDefaultDataPath(DatabaseEngine engine) {
        return switch (engine) {
            case POSTGRES -> "/var/lib/postgresql/data";
            case MYSQL, MARIADB -> "/var/lib/mysql";
        };
    }

    public void removeVolume(String instanceId, String volumeId) {
        if (ContainerStorageHelper.isNamedVolumeMode(config)) {
            ContainerStorageHelper.removeStorage(config, lifecycleManager, "rds", volumeId, instanceId);
        }
        // host-path mode: host directories are not removed automatically
    }

    private List<String> buildEnvVars(DatabaseEngine engine, String masterUsername,
                                      String masterPassword, String dbName) {
        String effectiveUser = (masterUsername != null && !masterUsername.isBlank()) ? masterUsername : "postgres";
        String effectiveDb = (dbName != null && !dbName.isBlank()) ? dbName : effectiveUser;

        List<String> envs = new ArrayList<>();
        switch (engine) {
            case POSTGRES -> {
                envs.add("POSTGRES_USER=" + effectiveUser);
                envs.add("POSTGRES_PASSWORD=" + masterPassword);
                envs.add("POSTGRES_DB=" + effectiveDb);
                envs.add("POSTGRES_HOST_AUTH_METHOD=md5");
            }
            case MYSQL -> {
                envs.add("MYSQL_ROOT_PASSWORD=" + masterPassword);
                if (!"root".equals(effectiveUser)) {
                    envs.add("MYSQL_USER=" + effectiveUser);
                    envs.add("MYSQL_PASSWORD=" + masterPassword);
                }
                envs.add("MYSQL_DATABASE=" + effectiveDb);
            }
            case MARIADB -> {
                envs.add("MARIADB_ROOT_PASSWORD=" + masterPassword);
                if (!"root".equals(effectiveUser)) {
                    envs.add("MARIADB_USER=" + effectiveUser);
                    envs.add("MARIADB_PASSWORD=" + masterPassword);
                }
                envs.add("MARIADB_DATABASE=" + effectiveDb);
            }
        }
        return envs;
    }

    private List<String> buildContainerCmd(DatabaseEngine engine) {
        // Configure MySQL to use mysql_native_password so the proxy can authenticate
        // without needing caching_sha2_password RSA key exchange
        return switch (engine) {
            case MYSQL -> List.of("--default-authentication-plugin=mysql_native_password");
            case POSTGRES, MARIADB -> List.of();
        };
    }
}
