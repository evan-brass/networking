/**
 * 1. Deserializes packets
 *   1a. Route them forward if we aren't the intended recipient
 * 2. Serializes messages into packets
 * 3. Handles Retransmission:
 *   1. Listen for routing acknowledgements (reset the retransmit timer as long as the message is making progress)
 *   2. When the retransmit timer expires:
 *     1-2. Retransmit the message - new starting connection
 *     3. Convert the message from a path message to a target message and retransmit
 *     4. Drop the packet and log a warning.
 *        TODO: If we're seeing a lot of dropped packets then consider evicting a random connection and rebootstrapping.
 */

export const messages = new EventTarget();

export async function handle_data(peer_id, data) {

}

export async function send_msg(targetOrConnOrPath, msg) {

}