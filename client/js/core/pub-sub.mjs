import { PeerConnection } from "./peer-connection.mjs";
import { our_peerid } from "./peer-id.mjs";

/**
 * The Rendevous protocol.
 * To join a topic / room, a peer routes a subscribe message to the closest peer to the topic's kad_id.  Peers hold on to that subscription message.  When another subscription message comes in, the first subscription message is source routed to the sender of the second subscription message.  This creates a quite long back_path.  Also, while loops are not allowed in the forward_path, a cycle can exist in the back_path due to this kind of forwarding.
 * By holding the message and forwarding it, we automatically get subscription expiration (using the message expiration).  We also get automatic verification, because a peer couldn't forge a message subscribing a peer to a topic.  Lastly, by forwarding the message, we can support peers that have not inserted themselves into the Kademlia topology.
 * (I'm still on the fence over whether or not every peer should be required to participate / insert themselves into the DHT, but at least for subscribe messages we don't need to rely on DHT routing.  With said, the back_path may have become invalid since the subscribe message was sent, so we can't be certain that the message will be delivered.  We can partially work around this by periodically sending a new subscribe message.  This will hopefully be routed successfully and will collect a fresh path from the peer -> rendezvous point.)
 * Subscribe messages should be forwarded to siblings (that don't appear in the back_path) so that they can take over responding in case we leave the network.  Also, when we get a new sibling, we should get them up to date by forwarding the subscribe messages we have in our rendezvous_table to them.
 */

// A subscribe message represents a peer's wish to be introduced to other peers 
const subscribe_msg = {
	type: 'subscribe',
	topic: '0x15', // The BigInt kad-id encoded as a hex string
	expiration: "message expiration timestamp"
};
const unsubscribe_msg = {
	type: 'unsubscribe',
	topic: '0x15', // The BigInt kad-id encoded as a hex string
	expiration: "Message expiration timestamp"
};
// Subscribe_peer could also be used to forward unsubscribe messages.
const subscribe_peer_msg = {
	type: 'subscribe_peer',
	subscribe_body: "<body that was sent in a subscribe message>",
	subscribe_sig: "<signature that was attached to the subscribe message>",
	subscribe_back_path: "<back path that the subscribe message took to reach the rendezvous server>"
};
const topic_broadcast_msg = {
	type: 'topic_broadcast',
	topics: ['0x15', '0x2365']
};

// topic -> Map(peer_id -> subscribe message info)
const rendezvous_table = new Map();

// Store a list of the topics that we are subscribed too:
// topic -> Set<origin>  (We use a set because multiple apps might subscribe to the same topic)
const topics = new Map();

export function subscribe(topic_kad) {
	
}