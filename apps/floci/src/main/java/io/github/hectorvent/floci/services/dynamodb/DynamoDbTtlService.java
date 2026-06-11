package io.github.hectorvent.floci.services.dynamodb;

import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import jakarta.enterprise.context.ApplicationScoped;
import jakarta.inject.Inject;
import org.jboss.logging.Logger;

import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

@ApplicationScoped
public class DynamoDbTtlService {

    private static final Logger LOG = Logger.getLogger(DynamoDbTtlService.class);

    private final DynamoDbService dynamoDbService;
    private final ScheduledExecutorService scheduler;

    @Inject
    public DynamoDbTtlService(DynamoDbService dynamoDbService) {
        this.dynamoDbService = dynamoDbService;
        this.scheduler = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "dynamodb-ttl-sweeper");
            t.setDaemon(true);
            return t;
        });
    }

    @PostConstruct
    void init() {
        scheduler.scheduleAtFixedRate(dynamoDbService::deleteExpiredItems, 60, 60, TimeUnit.SECONDS);
        LOG.infov("DynamoDB TTL sweeper scheduled (60s interval)");
    }

    @PreDestroy
    void shutdown() {
        scheduler.shutdownNow();
    }
}
