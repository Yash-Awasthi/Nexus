package io.github.hectorvent.floci.services.s3.model;

public record ObjectLockRetention(String mode, String unit, int value) {}
