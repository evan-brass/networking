use std::hash::Hasher;
use std::{collections::HashMap, hash::Hash};

use eyre::Result;

use serde::{de::Visitor, Deserialize, Deserializer, Serialize, Serializer};
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;

use p256::ecdsa::{Signature as P256Signature, VerifyingKey};

#[derive(Debug)]
pub struct Signature(pub P256Signature);
impl Serialize for Signature {
	fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
		base64::encode(self.0).serialize(s)
	}
}
struct SignatureVisitor;
impl<'de> Visitor<'de> for SignatureVisitor {
	type Value = Signature;
	fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
		formatter.write_str("Expecting a base64 string that encodes a P-256 Signature using asn.1")
	}
	fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<Self::Value, E> {
		let bytes = base64::decode(v).map_err(|_e| E::custom("found invalid base64"))?;
		let sig = P256Signature::try_from(bytes.as_ref())
			.map_err(|_e| E::custom("couldn't read signature"))?;
		Ok(Signature(sig))
	}
}
impl<'de> Deserialize<'de> for Signature {
	fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
		d.deserialize_str(SignatureVisitor)
	}
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct PeerId(pub VerifyingKey);
impl Serialize for PeerId {
	fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
		base64::encode(self.0.to_encoded_point(true)).serialize(s)
	}
}
struct PeerIdVisitor;
impl<'de> Visitor<'de> for PeerIdVisitor {
	type Value = PeerId;
	fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
		formatter.write_str("Expecting a base64 string that encodes a P-256 Signature")
	}
	fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<Self::Value, E> {
		let bytes = base64::decode(v).map_err(|_e| E::custom("found invalid base64"))?;
		let key =
			VerifyingKey::from_sec1_bytes(&bytes).map_err(|_e| E::custom("found invalid SEC1"))?;
		Ok(PeerId(key))
	}
}
impl<'de> Deserialize<'de> for PeerId {
	fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
		d.deserialize_str(PeerIdVisitor)
	}
}
impl Hash for PeerId {
	fn hash<H: Hasher>(&self, state: &mut H) {
		let point = self.0.to_encoded_point(false);
		for b in point.as_ref() {
			state.write_u8(*b);
		}
	}
}

/// For now it's easiest to get started with JSON, but I intend to switch to protocol buffers later
/// In fact, GossipSub's messages are defined in protobuf.

// For now the peer_id and signatures will be encoded as base64 strings.
// TODO: Replace these with properly sized [u8; 32] or whatever the crypto library uses internally once we switch to a binary protocol

#[derive(Debug, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Message {
	Routable(RoutableMessage),
	UnRoutable(UnRoutableMessage),
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[serde(tag = "type")]
pub enum RoutableMessage {
	Connect {
		#[serde(default)]
		sdp: Option<RTCSessionDescription>,
		#[serde(default)]
		ice: Option<RTCIceCandidateInit>,
	},
	Addresses {
		// TODO: Make an Enum for the addresses: WebSocket, WebPush, etc.
		addresses: Vec<String>,
	},
	RoutingTable {
		peers: Vec<PeerId>,
	},
	Error {
		msg: String,
		#[serde(flatten)]
		data: HashMap<String, String>,
	}, // TODO: DHT
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[serde(tag = "type")]
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
		content: RoutableMessage,
	},
	AppData {
		// Send data to a peer (this is unroutable so if you want to send data to a peer you must have a direct connection to them)
		content: String,
	}, // TODO: GossipSub
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FullMessage {
	pub origin: PeerId,
	pub body: String,
	pub signature: Signature,
}
impl FullMessage {
	pub fn verify(self: Self) -> Result<VerifiedMessage> {
		let Self {
			origin,
			body,
			signature: _,
		} = self;
		// TODO: verify the signature on the body
		let message = serde_json::from_str(&body)?;

		Ok(VerifiedMessage { origin, message })
	}
}

pub struct VerifiedMessage {
	pub origin: PeerId,
	pub message: Message,
}
