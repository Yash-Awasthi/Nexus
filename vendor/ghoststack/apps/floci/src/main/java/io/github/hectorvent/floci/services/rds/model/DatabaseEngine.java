package io.github.hectorvent.floci.services.rds.model;

public enum DatabaseEngine {
    POSTGRES, MYSQL, MARIADB;

    public int defaultPort() {
        return switch (this) {
            case POSTGRES -> 5432;
            case MYSQL, MARIADB -> 3306;
        };
    }
}
