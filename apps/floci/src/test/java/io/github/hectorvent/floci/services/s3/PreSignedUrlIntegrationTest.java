package io.github.hectorvent.floci.services.s3;

import io.quarkus.test.junit.QuarkusTest;
import jakarta.inject.Inject;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestMethodOrder;

import java.net.URI;

import static io.restassured.RestAssured.given;
import static org.hamcrest.Matchers.*;
import static org.junit.jupiter.api.Assertions.*;

@QuarkusTest
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class PreSignedUrlIntegrationTest {

    private static final String BUCKET = "presign-test-bucket";

    @Inject
    PreSignedUrlGenerator presignGenerator;

    @Test
    @Order(1)
    void createBucketAndUploadObject() {
        given().when().put("/" + BUCKET).then().statusCode(200);
        given()
            .body("presigned content")
            .contentType("text/plain")
        .when()
            .put("/" + BUCKET + "/secret-file.txt")
        .then()
            .statusCode(200);
    }

    @Test
    @Order(2)
    void accessWithPresignedGetUrl() {
        int port = io.restassured.RestAssured.port;
        String fullBaseUrl = "http://localhost:" + port;

        String presignedUrl = presignGenerator.generatePresignedUrl(
                fullBaseUrl, BUCKET, "secret-file.txt", "GET", 3600);

        // Extract path and query from the URL
        URI uri = URI.create(presignedUrl);

        given()
        .when()
            .get(uri.getRawPath() + "?" + uri.getRawQuery())
        .then()
            .statusCode(200)
            .body(equalTo("presigned content"));
    }

    @Test
    @Order(3)
    void presignedUrlGeneratesValidStructure() {
        String url = presignGenerator.generatePresignedUrl(
                "http://localhost:4566", BUCKET, "file.txt", "GET", 300);

        assertTrue(url.contains("X-Amz-Algorithm=AWS4-HMAC-SHA256"));
        assertTrue(url.contains("X-Amz-Credential="));
        assertTrue(url.contains("X-Amz-Date="));
        assertTrue(url.contains("X-Amz-Expires=300"));
        assertTrue(url.contains("X-Amz-SignedHeaders=host"));
        assertTrue(url.contains("X-Amz-Signature="));
    }

    @Test
    @Order(4)
    void expiredPresignedUrlReturns403() {
        // Create a URL with expired date by constructing manually
        int port = io.restassured.RestAssured.port;

        // Use an obviously expired date (year 2020)
        String expiredPath = "/" + BUCKET + "/secret-file.txt"
                + "?X-Amz-Algorithm=AWS4-HMAC-SHA256"
                + "&X-Amz-Credential=test"
                + "&X-Amz-Date=20200101T000000Z"
                + "&X-Amz-Expires=1"
                + "&X-Amz-SignedHeaders=host"
                + "&X-Amz-Signature=invalidsig";

        given()
        .when()
            .get(expiredPath)
        .then()
            .statusCode(403)
            .body(containsString("AccessDenied"));
    }

    @Test
    @Order(5)
    void presignedPutUrl() {
        int port = io.restassured.RestAssured.port;
        String fullBaseUrl = "http://localhost:" + port;
        String url = presignGenerator.generatePresignedUrl(
                fullBaseUrl, BUCKET, "uploaded-via-presign.txt", "PUT", 3600);

        URI uri = URI.create(url);

        given()
            .body("uploaded via presigned PUT")
        .when()
            .put(uri.getRawPath() + "?" + uri.getRawQuery())
        .then()
            .statusCode(200);

        // Verify the object was created
        given()
        .when()
            .get("/" + BUCKET + "/uploaded-via-presign.txt")
        .then()
            .statusCode(200)
            .body(equalTo("uploaded via presigned PUT"));
    }

    @Test
    @Order(6)
    void cleanUp() {
        given().when().delete("/" + BUCKET + "/secret-file.txt").then().statusCode(204);
        given().when().delete("/" + BUCKET + "/uploaded-via-presign.txt").then().statusCode(204);
        given().when().delete("/" + BUCKET).then().statusCode(204);
    }
}
