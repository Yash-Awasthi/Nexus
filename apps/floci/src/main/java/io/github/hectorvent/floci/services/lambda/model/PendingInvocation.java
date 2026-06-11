package io.github.hectorvent.floci.services.lambda.model;

import java.util.concurrent.CompletableFuture;

public class PendingInvocation {

    private final String requestId;
    private final byte[] payload;
    private final long deadlineMs;
    private final String functionArn;
    private final CompletableFuture<InvokeResult> resultFuture;

    public PendingInvocation(String requestId, byte[] payload, long deadlineMs,
                              String functionArn, CompletableFuture<InvokeResult> resultFuture) {
        this.requestId = requestId;
        this.payload = payload;
        this.deadlineMs = deadlineMs;
        this.functionArn = functionArn;
        this.resultFuture = resultFuture;
    }

    public String getRequestId() { return requestId; }
    public byte[] getPayload() { return payload; }
    public long getDeadlineMs() { return deadlineMs; }
    public String getFunctionArn() { return functionArn; }
    public CompletableFuture<InvokeResult> getResultFuture() { return resultFuture; }
}
