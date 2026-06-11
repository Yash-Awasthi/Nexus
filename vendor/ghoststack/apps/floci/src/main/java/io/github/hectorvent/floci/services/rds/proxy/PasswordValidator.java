package io.github.hectorvent.floci.services.rds.proxy;

@FunctionalInterface
    public interface PasswordValidator {
        boolean validate(String username, String password);
    }