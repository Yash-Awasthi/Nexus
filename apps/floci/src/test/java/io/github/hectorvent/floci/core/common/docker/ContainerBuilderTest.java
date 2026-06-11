package io.github.hectorvent.floci.core.common.docker;

import io.github.hectorvent.floci.config.EmulatorConfig;
import io.github.hectorvent.floci.core.common.dns.EmbeddedDnsServer;
import org.junit.jupiter.api.Test;

import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class ContainerBuilderTest {

    @Test
    void withDockerNetwork_usesExplicitServiceNetworkFirst() {
        TestFixture fixture = new TestFixture();
        when(fixture.currentContainerNetworkResolver.resolveNetworkName()).thenReturn(Optional.of("compose_default"));

        ContainerSpec spec = fixture.builder.newContainer("alpine")
                .withDockerNetwork(Optional.of("lambda_network"))
                .build();

        assertEquals("lambda_network", spec.networkMode());
    }

    @Test
    void withDockerNetwork_usesGlobalNetworkBeforeDetectedCurrentNetwork() {
        TestFixture fixture = new TestFixture();
        when(fixture.services.dockerNetwork()).thenReturn(Optional.of("global_network"));
        when(fixture.currentContainerNetworkResolver.resolveNetworkName()).thenReturn(Optional.of("compose_default"));

        ContainerSpec spec = fixture.builder.newContainer("alpine")
                .withDockerNetwork(Optional.empty())
                .build();

        assertEquals("global_network", spec.networkMode());
    }

    @Test
    void withDockerNetwork_inheritsCurrentContainerNetworkWhenNoConfigIsSet() {
        TestFixture fixture = new TestFixture();
        when(fixture.currentContainerNetworkResolver.resolveNetworkName()).thenReturn(Optional.of("avoxx-network"));

        ContainerSpec spec = fixture.builder.newContainer("alpine")
                .withDockerNetwork(Optional.empty())
                .build();

        assertEquals("avoxx-network", spec.networkMode());
    }

    private static class TestFixture {
        final EmulatorConfig config = mock(EmulatorConfig.class);
        final EmulatorConfig.ServicesConfig services = mock(EmulatorConfig.ServicesConfig.class);
        final EmulatorConfig.DockerConfig docker = mock(EmulatorConfig.DockerConfig.class);
        final DockerHostResolver dockerHostResolver = mock(DockerHostResolver.class);
        final EmbeddedDnsServer embeddedDnsServer = mock(EmbeddedDnsServer.class);
        final CurrentContainerNetworkResolver currentContainerNetworkResolver =
                mock(CurrentContainerNetworkResolver.class);
        final ContainerBuilder builder =
                new ContainerBuilder(config, dockerHostResolver, embeddedDnsServer, currentContainerNetworkResolver);

        TestFixture() {
            when(config.services()).thenReturn(services);
            when(services.dockerNetwork()).thenReturn(Optional.empty());
            when(config.docker()).thenReturn(docker);
            when(docker.logMaxSize()).thenReturn("10m");
            when(docker.logMaxFile()).thenReturn("3");
            when(embeddedDnsServer.getServerIp()).thenReturn(Optional.empty());
        }
    }
}
