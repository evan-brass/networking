#![feature(once_cell)]
use std::error::Error;
use std::lazy::SyncLazy;
use std::collections::HashMap;
use std::pin::Pin;

use tokio_tungstenite::accept_async;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;
use webrtc::data_channel::RTCDataChannel;
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::protocol::Message as WSMessage;
use tokio_tungstenite::WebSocketStream;
use p256::ecdsa::signature::Signer;

mod messages;
use messages::{FullMessage, VerifiedMessage, Message, RoutableMessage, UnRoutableMessage, Signature, PeerId};

static ROUTING_TABLE: SyncLazy<Mutex<HashMap<String, RTCDataChannel>>> = SyncLazy::new(|| {
	Mutex::new(HashMap::new())
});

static PEER_KEY: SyncLazy<p256::ecdsa::SigningKey> = SyncLazy::new(|| {
	p256::ecdsa::SigningKey::random(rand::thread_rng())
});

fn sign_message(msg: &Message) -> Result<FullMessage, Box<dyn Error>> {
	let body = serde_json::to_string(&msg)?;
	let signature = PEER_KEY.sign(body.as_bytes());
	let signature = Signature(signature);
	let origin = PeerId(PEER_KEY.verify_key());
	Ok(FullMessage {
		origin, body, signature
	})
}


#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
	let listener = TcpListener::bind("0.0.0.0:3030").await?;

	loop {
		let (stream, _addr) = listener.accept().await?;
		tokio::spawn(async {
			if let Err(e) = handle_conn(stream).await {
				eprintln!("{:?}", e);
			}
		});
	}
}

async fn handle_conn(stream: TcpStream) -> Result<(), Box<dyn Error>> {
	let mut ws = accept_async(stream).await?;
	// The first thing we do is send an addresses message so that the client on the other side knows what our peer_id is.
	let addr = sign_message(&Message::Routable(RoutableMessage::Addresses { addresses: vec![String::from("ws://localhost:3030")] }))?;
	ws.feed(WSMessage::Text(
		serde_json::to_string(&addr)?
	)).await?;

	// Listen for messages
	while let Some(Ok(msg)) = ws.next().await {
		if let WSMessage::Text(s) = msg {
			if let Ok(m) = serde_json::from_str::<FullMessage>(&s) {
				if let Err(e) = handle_ws_message(m, &mut ws).await {
					eprintln!("{:?}", e);
					break;
				}
			} else {
				break;
			}
		} else if let WSMessage::Close(_) = msg {
			break;
		}
	}
	ws.close(None).await?;
	Ok(())
}

async fn handle_ws_message(m: FullMessage, ws: &mut WebSocketStream<TcpStream>) -> Result<(), Box<dyn Error>> {
	// TODO: verify the message
	let VerifiedMessage { origin, message } = m.verify()?;
	match message {
		Message::Routable(RoutableMessage::Addresses { addresses }) => {
			// Store the addresses into our known addresses for this peer
		},
		_ => {

		}
	}

	Ok(())
}