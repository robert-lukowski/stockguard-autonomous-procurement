import {
  ConnectClient,
  StartWebRTCContactCommand,
} from "@aws-sdk/client-connect";

import type {
  ConnectWebRtcContactPort,
  StartWebRtcContactInput,
} from "./connectContact";

/**
 * The real Amazon Connect `StartWebRTCContact` boundary.
 *
 * This is the only file that can create a billable Amazon Connect contact, so
 * everything about it is deliberate:
 *
 *   - `enabled` is false unless the caller passes an instance id AND a contact
 *     flow id. A half-configured deployment therefore refuses rather than
 *     failing at call time with an AWS error.
 *   - `ParticipantDetails.DisplayName` is a fixed label, never the judge id.
 *     Connect writes it into contact records and agent UIs, and an identity
 *     does not belong there.
 *   - `Attributes` carry only the correlation values the Lex fulfilment needs
 *     to find the procurement session. No credential, no PII, no free text.
 *   - The raw response is returned as `unknown` on purpose. Projecting it is
 *     `parseConnectWebRtcResponse`'s job, and doing it here would put the
 *     allowlist in two places.
 */

/**
 * The single SDK call this file makes, narrowed to one command.
 *
 * `ConnectClient.send` is overloaded across every Connect command, which is
 * what forces an `any` cast at the call site. Narrowing to the one command we
 * issue removes the cast AND makes the port trivially mockable in tests.
 */
type StartWebRtcContactSender = {
  send(command: StartWebRTCContactCommand): Promise<unknown>;
};

export type AwsConnectWebRtcConfig = {
  instanceId: string;
  contactFlowId: string;
  region?: string;
  /** Injected in tests; production builds the client from the Lambda role. */
  client?: StartWebRtcContactSender;
};

export class AwsConnectWebRtcContactPort implements ConnectWebRtcContactPort {
  readonly enabled: boolean;
  private readonly client: StartWebRtcContactSender;

  constructor(private readonly config: AwsConnectWebRtcConfig) {
    this.enabled =
      config.instanceId.trim().length > 0 && config.contactFlowId.trim().length > 0;
    this.client =
      config.client ??
      (new ConnectClient(
        config.region ? { region: config.region } : {},
      ) as StartWebRtcContactSender);
  }

  async startWebRtcContact(input: StartWebRtcContactInput): Promise<unknown> {
    /*
     * ClientToken makes a retried request return the SAME contact instead of
     * starting a second one. Keyed on the procurement session, because that is
     * exactly the unit we already guarantee one grant for.
     */
    const command = new StartWebRTCContactCommand({
      InstanceId: this.config.instanceId,
      ContactFlowId: this.config.contactFlowId,
      ClientToken: `voice-${input.sessionId}`,
      ParticipantDetails: { DisplayName: "StockGuard judge" },
      Attributes: {
        stockguardSessionId: input.sessionId,
        stockguardMissionId: input.missionId,
      },
      AllowedCapabilities: {
        Customer: { Video: "SEND" },
        Agent: { Video: "SEND" },
      },
    });

    // Returned raw. Projecting it is parseConnectWebRtcResponse's job, and
    // doing it here would put the allowlist in two places.
    return await this.client.send(command);
  }
}
