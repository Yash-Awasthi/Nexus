package com.floci.test;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestMethodOrder;

import software.amazon.awssdk.services.ses.SesClient;
import software.amazon.awssdk.services.ses.model.GetAccountSendingEnabledResponse;
import software.amazon.awssdk.services.ses.model.UpdateAccountSendingEnabledRequest;

import software.amazon.awssdk.services.sesv2.SesV2Client;
import software.amazon.awssdk.services.sesv2.model.GetAccountRequest;
import software.amazon.awssdk.services.sesv2.model.GetAccountResponse;
import software.amazon.awssdk.services.sesv2.model.PutAccountSendingAttributesRequest;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("SES Account Sending Enabled (v1 + v2)")
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class SesAccountSendingTest {

    private static SesClient sesV1;
    private static SesV2Client sesV2;

    @BeforeAll
    static void setup() {
        sesV1 = TestFixtures.sesClient();
        sesV2 = TestFixtures.sesV2Client();
    }

    @AfterAll
    static void cleanup() {
        // Always restore the account-wide flag so it does not leak to other suites.
        if (sesV1 != null) {
            try {
                sesV1.updateAccountSendingEnabled(UpdateAccountSendingEnabledRequest.builder()
                        .enabled(true).build());
            } catch (Exception ignored) {}
            sesV1.close();
        }
        if (sesV2 != null) {
            sesV2.close();
        }
    }

    @Test
    @Order(1)
    void v1UpdateAccountSendingEnabled_disablesAndReenables() {
        sesV1.updateAccountSendingEnabled(UpdateAccountSendingEnabledRequest.builder()
                .enabled(false).build());

        GetAccountSendingEnabledResponse disabled = sesV1.getAccountSendingEnabled();
        assertThat(disabled.enabled()).isFalse();

        sesV1.updateAccountSendingEnabled(UpdateAccountSendingEnabledRequest.builder()
                .enabled(true).build());

        GetAccountSendingEnabledResponse enabled = sesV1.getAccountSendingEnabled();
        assertThat(enabled.enabled()).isTrue();
    }

    @Test
    @Order(2)
    void v1AndV2_shareAccountSendingState() {
        // Disable via v1, observe via v2 GetAccount
        sesV1.updateAccountSendingEnabled(UpdateAccountSendingEnabledRequest.builder()
                .enabled(false).build());

        GetAccountResponse afterV1Disable = sesV2.getAccount(GetAccountRequest.builder().build());
        assertThat(afterV1Disable.sendingEnabled()).isFalse();

        // Re-enable via v2, observe via v1 GetAccountSendingEnabled
        sesV2.putAccountSendingAttributes(PutAccountSendingAttributesRequest.builder()
                .sendingEnabled(true).build());

        GetAccountSendingEnabledResponse afterV2Enable = sesV1.getAccountSendingEnabled();
        assertThat(afterV2Enable.enabled()).isTrue();
    }
}
