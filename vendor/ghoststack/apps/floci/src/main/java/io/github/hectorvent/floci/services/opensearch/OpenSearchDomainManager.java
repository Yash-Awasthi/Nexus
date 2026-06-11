package io.github.hectorvent.floci.services.opensearch;

import io.github.hectorvent.floci.config.EmulatorConfig;
import io.github.hectorvent.floci.core.common.docker.ContainerBuilder;
import io.github.hectorvent.floci.core.common.docker.ContainerDetector;
import io.github.hectorvent.floci.core.common.docker.ContainerLifecycleManager;
import io.github.hectorvent.floci.core.common.docker.ContainerLifecycleManager.ContainerInfo;
import io.github.hectorvent.floci.core.common.docker.ContainerSpec;
import io.github.hectorvent.floci.core.common.docker.ContainerStorageHelper;
import io.github.hectorvent.floci.core.common.docker.PortAllocator;
import io.github.hectorvent.floci.services.opensearch.model.Domain;
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.inject.Inject;
import org.jboss.logging.Logger;

import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.file.Path;

/**
 * Manages the Docker lifecycle of OpenSearch containers for real-mode domains.
 * Not used when {@code floci.services.opensearch.mock=true}.
 */
@ApplicationScoped
public class OpenSearchDomainManager {

    private static final Logger LOG = Logger.getLogger(OpenSearchDomainManager.class);
    private static final int OPENSEARCH_PORT = 9200;

    private final ContainerBuilder containerBuilder;
    private final ContainerLifecycleManager lifecycleManager;
    private final ContainerDetector containerDetector;
    private final PortAllocator portAllocator;
    private final EmulatorConfig config;

    @Inject
    public OpenSearchDomainManager(ContainerBuilder containerBuilder,
                                   ContainerLifecycleManager lifecycleManager,
                                   ContainerDetector containerDetector,
                                   PortAllocator portAllocator,
                                   EmulatorConfig config) {
        this.containerBuilder = containerBuilder;
        this.lifecycleManager = lifecycleManager;
        this.containerDetector = containerDetector;
        this.portAllocator = portAllocator;
        this.config = config;
    }

    public void startDomain(Domain domain) {
        String image = config.services().opensearch().defaultImage();
        String containerName = "floci-opensearch-" + domain.getDomainName();

        LOG.infov("Starting OpenSearch container for domain: {0} using image {1}",
                domain.getDomainName(), image);

        int hostPort = portAllocator.allocate(
                config.services().opensearch().proxyBasePort(),
                config.services().opensearch().proxyMaxPort());

        lifecycleManager.removeIfExists(containerName);

        ContainerBuilder.Builder specBuilder = containerBuilder.newContainer(image)
                .withName(containerName)
                .withEnv("discovery.type", "single-node")
                .withEnv("DISABLE_SECURITY_PLUGIN", "true")
                .withPortBinding(OPENSEARCH_PORT, hostPort)
                .withDockerNetwork(config.services().dockerNetwork())
                .withLogRotation();

        if (ContainerStorageHelper.isNamedVolumeMode(config)) {
            ContainerStorageHelper.applyStorage(specBuilder, lifecycleManager,
                    "opensearch", domain.getVolumeId(), domain.getDomainName(),
                    "/usr/share/opensearch/data");
        } else {
            // Legacy host-path mode: host-persistent-path is an absolute path
            Path dataPath = Path.of(config.services().opensearch().dataPath(), domain.getDomainName());
            ContainerStorageHelper.ensureHostDir(dataPath.toString());
            String dataPathStr = dataPath.toAbsolutePath().normalize().toString();
            String persistentPathStr = Path.of(config.storage().persistentPath()).toAbsolutePath().normalize().toString();
            String hostDataPath = dataPathStr.replace(persistentPathStr, config.storage().hostPersistentPath());
            specBuilder.withBind(hostDataPath, "/usr/share/opensearch/data");
        }

        ContainerSpec spec = specBuilder.build();

        ContainerInfo info = lifecycleManager.createAndStart(spec);
        domain.setContainerId(info.containerId());

        if (containerDetector.isRunningInContainer()) {
            domain.setEndpoint("http://" + containerName + ":" + OPENSEARCH_PORT);
        } else {
            domain.setEndpoint("http://localhost:" + hostPort);
        }

        LOG.infov("OpenSearch container {0} started for domain {1} on port {2}",
                info.containerId(), domain.getDomainName(), hostPort);
    }

    public boolean isReady(Domain domain) {
        String containerName = "floci-opensearch-" + domain.getDomainName();
        String url = "http://" + containerName + ":" + OPENSEARCH_PORT + "/_cluster/health";
        try {
            HttpURLConnection conn = (HttpURLConnection) URI.create(url).toURL().openConnection();
            conn.setConnectTimeout(2000);
            conn.setReadTimeout(2000);
            int code = conn.getResponseCode();
            if (code == 200) {
                String body = new String(conn.getInputStream().readAllBytes());
                boolean ready = body.contains("\"green\"") || body.contains("\"yellow\"");
                if (ready) {
                    LOG.infov("OpenSearch domain {0} is ready (internal check)", domain.getDomainName());
                }
                return ready;
            }
            return false;
        } catch (Exception e) {
            // Silently ignore during polling
            return false;
        }
    }

    public void stopDomain(Domain domain) {
        if (domain.getContainerId() == null) {
            return;
        }
        if (config.services().opensearch().keepRunningOnShutdown()) {
            LOG.infov("Leaving OpenSearch container for domain {0} running", domain.getDomainName());
            return;
        }
        lifecycleManager.stopAndRemove(domain.getContainerId(), null);
        LOG.infov("Stopped OpenSearch container for domain {0}", domain.getDomainName());
    }

    public void removeDomainStorage(Domain domain) {
        ContainerStorageHelper.removeStorage(config, lifecycleManager,
                "opensearch", domain.getVolumeId(), domain.getDomainName());
    }
}
