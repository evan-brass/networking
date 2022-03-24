import { publicKey_encoded } from "./peer-id.mjs";
import { base64_decode } from "./lib.mjs";

/**
 * The Hyperspace network is an overlay network: our connections exist over the internet.
 * Once we've bootstrapped and have one connection, we need to add more connections and
 * organize our overlay network into a useful topology.  Kademlia is a Distributed Hash
 * Table (DHT) that's very common.  I propose that we use it as our topology organization
 * algorithm.  Kademlia expects all peers to be addressable (have a ip:port), but our
 * peers are mostly not addressable.  As such, our k-buckets can't store
 * peer-information, it must store actual connections.  We use path routing and for those
 * paths to converge when queried under the Kademlia protocol, our network topology must
 * reflect the Kademlia k-buckets metric.
 * However our network topology needs to support more than just DHT load / stores.  In
 * the future this may entail a scoring mechanism: eg. A peer may be important from a 
 * Kademlia perspective, but might be not-useful from a PubSub perspective (the peer is
 * not subscribed to the same topics that we're interested in) or it may not be running
 * the same distributed web apps that we are.
 * So, for now we'll just keep the routing tables sepperate: kad will maintain the peers
 * that it needs to be connected with, and PubSub will maintain its own list.
 * Kademlia will manage the main hyperspace-network datachannel.  GossipSub will probably
 * get its own data channel, that way the routing tables (containing datachannels) can
 * have their own structure (k-tables for kademlia and whatever gossip sub needs).
 * Additionally, since we can use seperate data channels, the messages can also be
 * independant protocols (seperate protobuf schemas).
 */

export async function kad_id_sha1(buffer) {
	const hash = new Uint8Array(await crypto.subtle.digest('SHA-1', buffer));
	return kad_id(hash);
}
export function kad_id(buffer) {
	const temp = '0x' + buffer.map(e => e.toString(16).padStart(2, '0')).join('');
	return BigInt(temp);
}
export function kad_dst(a, b) {
	console.assert(typeof a == 'bigint');
	console.assert(typeof b == 'bigint');
	return a ^ b;
}

export const our_kad_id = await kad_id(base64_decode(publicKey_encoded));

const buckets = [];