import { get_expiration, messages } from "./messages.mjs";
import { PeerConnection } from "./peer-connection.mjs";
import { lookup } from "./kbuckets.mjs";

export async function route_

/**
 * We need to handle connect_request messages only once (so that we don't apply the SDP more than once.)
 * KBucket connect_request messages have a bits field.
 * Sibling connect_request messages have their sibling range.
 * DWA connect_request messages have an origin field and we don't accept connections from anyone except the intended target.
 *   - I guess that this means we can't hide the origin like I was hoping.
 * A subscribe message is a kind of connect_request (it also needs to include encryption information for E2E encrypted SDP).
 */
/**
 * For connect messages, we need to know that the connection was requested by one of our topologies.
 * For now, I think this will be the body_sig from the connect_request message, but in the future it will probably be the ECDH key that is used for encrypting the SDP information.
 */

// Listen for connect and connect request messages
messages.addEventListener('connect', async ({ detail: { origin, body: { sdp }, back_path_parsed }}) => {
	// TODO: Check the other topologies if they 
	if (kbucket_could_fit(origin)) {
		const answer = await PeerConnection.handle_connect(origin, sdp);
		if (answer) {
			await PeerConnection.source_route(back_path_parsed, {
				type: 'connect',
				expiration: get_expiration(),
				sdp: answer
			});
		}
	}
});