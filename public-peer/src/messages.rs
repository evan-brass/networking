use serde::{Serialize, Deserialize};
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;

// TODO: change the peer id from being a string to being a [u8; 32] or whatever the public key is.
type PeerId = String;

pub enum Message {
	Routable(RoutableMessage),
	UnRoutableMessage(UnRoutableMessage)
}

pub enum RoutableMessage {
	Introduction {
		sdp: Option<RTCSessionDescription>,
		ice: Vec<RTCIceCandidateInit>
	},
	Addresses {
		// TODO: Make an Enum for the addresses: WebSocket, WebPush, etc.
		addresses: Vec<String>
	},
	RoutingTable {
		peers: Vec<PeerId>
	},
	Error {
		msg: String
	},
	// TODO: DHT
}
pub enum UnRoutableMessage {
	/// Source routing:
	/// The idea behind source routing is that instead of the network deciding the path for packets to travel, it's the sender who decides the path that packets should travel.  With that said, there are a few exceptions:
	/// 1. When a peer receives a SourceRoute message it checks if it is the last peer in the path.  If it is, then it handles the Unroutable 'content' message.
	/// 2. If it is not the last peer in the path, then it starts searching through the path from the end for the first peer that it has in it's routing table.  It then forwards the message to that peer.
	/// 	1. If it reaches it's own peer_id without finding a peer in its own routing table, then it creates an "undeliverable" error message and sends it back along the reverse of the path.
	SourceRoute {
		// The path is a list of peers through whom the message should travel on it's way to the last peer in the path.
		path: Vec<PeerId>,
		// The contents is the serialized message, that is intended for the last peer in the path.
		content: RoutableMessage
	},
	Data {
		// Send data to a peer (this is unroutable so if you want to send data to a peer you must have a direct connection to them)
	},
	// TODO: GossipSub
}
