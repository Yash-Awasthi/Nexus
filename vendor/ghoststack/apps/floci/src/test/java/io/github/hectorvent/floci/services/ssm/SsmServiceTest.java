package io.github.hectorvent.floci.services.ssm;

import io.github.hectorvent.floci.core.common.AwsException;
import io.github.hectorvent.floci.core.storage.InMemoryStorage;
import io.github.hectorvent.floci.services.ssm.model.Parameter;
import io.github.hectorvent.floci.services.ssm.model.ParameterHistory;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class SsmServiceTest {

    private SsmService ssmService;

    @BeforeEach
    void setUp() {
        ssmService = new SsmService(
                new InMemoryStorage<>(),
                new InMemoryStorage<>(),
                5
        );
    }

    @Test
    void putAndGetParameter() {
        ssmService.putParameter("/app/db/host", "localhost", "String", null, false);
        Parameter param = ssmService.getParameter("/app/db/host");

        assertEquals("/app/db/host", param.getName());
        assertEquals("localhost", param.getValue());
        assertEquals("String", param.getType());
        assertEquals(1, param.getVersion());
        assertNotNull(param.getLastModifiedDate());
    }

    @Test
    void putParameterOverwrite() {
        ssmService.putParameter("/app/key", "v1", "String", null, false);
        ssmService.putParameter("/app/key", "v2", "String", null, true);
        Parameter param = ssmService.getParameter("/app/key");

        assertEquals("v2", param.getValue());
        assertEquals(2, param.getVersion());
    }

    @Test
    void putParameterWithoutOverwriteThrows() {
        ssmService.putParameter("/app/key", "v1", "String", null, false);
        assertThrows(AwsException.class, () ->
                ssmService.putParameter("/app/key", "v2", "String", null, false));
    }

    @Test
    void getParameterNotFound() {
        AwsException ex = assertThrows(AwsException.class, () ->
                ssmService.getParameter("/nonexistent"));
        assertEquals("ParameterNotFound", ex.getErrorCode());
    }

    @Test
    void getParameters() {
        ssmService.putParameter("/a", "1", "String", null, false);
        ssmService.putParameter("/b", "2", "String", null, false);
        ssmService.putParameter("/c", "3", "String", null, false);

        List<Parameter> params = ssmService.getParameters(List.of("/a", "/c", "/missing"));
        assertEquals(2, params.size());
    }

    @Test
    void getParametersByPathRecursive() {
        ssmService.putParameter("/app/db/host", "localhost", "String", null, false);
        ssmService.putParameter("/app/db/port", "5432", "String", null, false);
        ssmService.putParameter("/app/db/nested/deep", "value", "String", null, false);
        ssmService.putParameter("/app/cache/host", "redis", "String", null, false);

        List<Parameter> results = ssmService.getParametersByPath("/app/db", true);
        assertEquals(3, results.size());
    }

    @Test
    void getParametersByPathNonRecursive() {
        ssmService.putParameter("/app/db/host", "localhost", "String", null, false);
        ssmService.putParameter("/app/db/port", "5432", "String", null, false);
        ssmService.putParameter("/app/db/nested/deep", "value", "String", null, false);

        List<Parameter> results = ssmService.getParametersByPath("/app/db", false);
        assertEquals(2, results.size());
    }

    @Test
    void deleteParameter() {
        ssmService.putParameter("/app/key", "value", "String", null, false);
        ssmService.deleteParameter("/app/key");
        assertThrows(AwsException.class, () -> ssmService.getParameter("/app/key"));
    }

    @Test
    void deleteParameterNotFoundThrows() {
        assertThrows(AwsException.class, () -> ssmService.deleteParameter("/missing"));
    }

    @Test
    void deleteParameters() {
        ssmService.putParameter("/a", "1", "String", null, false);
        ssmService.putParameter("/b", "2", "String", null, false);

        List<String> deleted = ssmService.deleteParameters(List.of("/a", "/missing"));
        assertEquals(1, deleted.size());
        assertEquals("/a", deleted.getFirst());
    }

    @Test
    void getParameterHistory() {
        ssmService.putParameter("/app/key", "v1", "String", null, false);
        ssmService.putParameter("/app/key", "v2", "String", null, true);
        ssmService.putParameter("/app/key", "v3", "String", null, true);

        List<ParameterHistory> history = ssmService.getParameterHistory("/app/key");
        assertEquals(3, history.size());
        assertEquals("v1", history.get(0).getValue());
        assertEquals("v3", history.get(2).getValue());
    }

    @Test
    void parameterHistoryIsTrimmedToMax() {
        for (int i = 1; i <= 7; i++) {
            ssmService.putParameter("/app/key", "v" + i, "String", null, i == 1 ? false : true);
        }

        List<ParameterHistory> history = ssmService.getParameterHistory("/app/key");
        assertEquals(5, history.size());
        assertEquals("v3", history.get(0).getValue());
        assertEquals("v7", history.get(4).getValue());
    }
}
