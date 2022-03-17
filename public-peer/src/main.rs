#![feature(once_cell)]
use std::lazy::SyncLazy;
use std::collections::HashMap;
use std::sync::Arc;

use eyre::Result;
use eyre::eyre;

use tokio_tungstenite::accept_async;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::RwLock;
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::mpsc::Sender;
use tokio::sync::mpsc::unbounded_channel;
use webrtc::data_channel::RTCDataChannel;
use webrtc::api::API;
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::protocol::Message as WSMessage;
use p256::ecdsa::signature::Signer;

mod messages;
use messages::{FullMessage, VerifiedMessage, Message, RoutableMessage, Signature, PeerId};
use webrtc::data_channel::data_channel_init::RTCDataChannelInit;
use webrtc::ice_transport::ice_credential_type::RTCIceCredentialType;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::peer_connection::sdp::sdp_type::RTCSdpType;


enum Route {
	WS(UnboundedSender<WSMessage>),
	DC(Arc<RTCDataChannel>)
}
impl Route {
	pub async fn send(&self, msg: &Message) -> Result<()> {
		let fm = sign_message(&msg)?;
		let data = serde_json::to_string(&fm)?;
		match self {
			Route::WS(ws) => {
				println!("Sending a message over websocket");
				ws.send(WSMessage::Text(data))?;
			},
			Route::DC(dc) => {
				println!("Sending a message over RTCDataChannel.");
				dc.send_text(data).await?;
			}
		}

		Ok(())
	}
}


// The routing_table contains only *open* connections to a peer.  We can't put pending websockets or datachannels in here.
static ROUTING_TABLE: SyncLazy<RwLock<HashMap<PeerId, Route>>> = SyncLazy::new(|| {
	RwLock::new(HashMap::new())
});

static CONNECTION_TABLE: SyncLazy<RwLock<HashMap<PeerId, RTCPeerConnection>>> = SyncLazy::new(|| {
	RwLock::new(HashMap::new())
});

static PEER_KEY: SyncLazy<p256::ecdsa::SigningKey> = SyncLazy::new(|| {
	p256::ecdsa::SigningKey::random(rand::thread_rng())
});

static RTC_API: SyncLazy<API> = SyncLazy::new(|| {
	webrtc::api::APIBuilder::new().build()
});


fn sign_message(msg: &Message) -> Result<FullMessage> {
	let body = serde_json::to_string(&msg)?;
	let signature = PEER_KEY.sign(body.as_bytes());
	let signature = Signature(signature);
	let origin = PeerId(PEER_KEY.verify_key());
	Ok(FullMessage {
		origin, body, signature
	})
}


#[tokio::main]
async fn main() -> Result<()> {
	console_subscriber::init();

	let listener = TcpListener::bind("0.0.0.0:3030").await?;

	let (sender, mut recv) = tokio::sync::mpsc::channel::<VerifiedMessage>(10);

	// Listen to and handle messages (whether from WS or DC)
	let handle_sender = sender.clone();
	tokio::spawn(async move {
		while let Some(m) = recv.recv().await {
			handle_message(handle_sender.clone(), m).await.unwrap();
			println!("Finished handling message.");
		}
	});

	// Listen to incoming WebSockets
	loop {
		let (stream, _addr) = listener.accept().await?;
		let sender = sender.clone();
		tokio::spawn(async {
			if let Err(e) = handle_conn(sender, stream).await {
				eprintln!("{:?}", e);
			}
		});
	}
}

async fn handle_conn(sender: Sender<VerifiedMessage>, stream: TcpStream) -> Result<()> {
	let mut ws = accept_async(stream).await?;


	// The first thing we do is send an addresses message so that the client on the other side knows what our peer_id is.
	let addr = sign_message(&Message::Routable(RoutableMessage::Addresses { 
		addresses: vec![String::from("ws://localhost:3030")]
	}))?;
	ws.feed(WSMessage::Text(
		serde_json::to_string(&addr)?
	)).await?;

	// We need to listen for the first verified message so that we can insert the WebSocket into our routing table:
	if let Some(Ok(WSMessage::Text(s))) = ws.next().await {
		let fm = serde_json::from_str::<FullMessage>(&s)?;
		let vm = fm.verify()?;


		let (mut sink, mut stream) = ws.split();
		let (tx, mut rx) = unbounded_channel();

		let mut rt = ROUTING_TABLE.write().await;
		rt.insert(vm.origin.clone(), Route::WS(tx));

		sender.send(vm).await.map_err(|_| eyre!("Failed to send verified message"))?;

		// Continue reading the websocket until it closes
		tokio::spawn(async move {
			while let Some(Ok(WSMessage::Text(s))) = stream.next().await {
				let fm = serde_json::from_str::<FullMessage>(&s)?;
				let vm = fm.verify()?;
		
				sender.send(vm).await
					.map_err(|_| eyre!("Failed to send verified message"))?;
			}
			Result::<(), eyre::Report>::Ok(())
		});

		// Send any messages on from the tx
		tokio::spawn(async move {
			while let Some(m) = rx.recv().await {
				sink.send(m).await?;
			}
			Result::<(), eyre::Report>::Ok(())
		});
	}
	Ok(())
}

async fn create_connection(sender: Sender<VerifiedMessage>, origin: PeerId, reply: Arc<Reply>) -> Result<RTCPeerConnection> {
	println!("Creating RTCPeerConnection");

	let mut config = RTCConfiguration::default();
	config.ice_servers = vec![RTCIceServer {
		urls: vec![
			String::from("stun:stun.l.google.com:19302"),
			String::from("stun:stun1.l.google.com:19302"),
			String::from("stun:stun2.l.google.com:19302"),
			String::from("stun:stun3.l.google.com:19302"),
			String::from("stun:stun4.l.google.com:19302")
		],
		username: String::new(),
		credential: String::new(),
		credential_type: RTCIceCredentialType::Unspecified
	}];
	let ret = RTC_API.new_peer_connection(config).await?;

	// This may be the most ugly code I've ever written.  Yuck.
	let nn_reply = reply.clone();
	let nn_origin = origin.clone();
	ret.on_negotiation_needed(Box::new(move || {
		println!("Negotiation Needed");

		let origin = nn_origin.clone();
		let reply = nn_reply.clone();
		Box::pin(async move {
			// TODO: remove the .unwraps here
			let conn_table = CONNECTION_TABLE.read().await;
			let conn: &RTCPeerConnection = conn_table.get(&origin).unwrap();
			let sdp = Some(conn.create_offer(None).await.unwrap());
			reply.reply(RoutableMessage::Connect { sdp, ice: None }).await.unwrap();
		})
	})).await;

	ret.on_data_channel(Box::new(move |dc| {
		println!("Received a data channel.");
		Box::pin(async move {

		})
	})).await;

	let ice_reply = reply.clone();
	ret.on_ice_candidate(Box::new(move |candidate| {
		let reply = ice_reply.clone();
		Box::pin(async move {
			// TODO: remove the .unwraps here
			if let Some(candidate) = candidate {
				reply.reply(RoutableMessage::Connect { sdp: None, ice: Some(
					candidate.to_json().await.unwrap()
				) }).await.unwrap();
			}
		})
	})).await;

	let channel = ret.create_data_channel("hyperspace-protocol", Some(RTCDataChannelInit {
		negotiated: Some(true),
		id: Some(42),
		ordered: None,
		max_packet_life_time: None,
		max_retransmits: None,
		protocol: None
	})).await?;

	channel.on_message(Box::new(move |DataChannelMessage {is_string: _, data}| {
		let local_sender = sender.clone();
		Box::pin(async move {
			let s = std::str::from_utf8(data.as_ref()).unwrap();
			let fm = serde_json::from_str::<FullMessage>(&s).unwrap();
			let vm = fm.verify().unwrap();
			local_sender.send(vm).await.map_err(|_| ()).unwrap();
		})
	})).await;
	
	let dc = channel.clone();
	channel.on_open(Box::new(|| {
		println!("New RTCDataChannel Openned!");
		Box::pin(async move {
			let mut rt = ROUTING_TABLE.write().await;
			rt.insert(origin, Route::DC(dc));
		})
	})).await;

	Ok(ret)
}

#[derive(Clone)]
enum Reply {
	Direct(PeerId)
	// TODO: add a path reply for responding to routed messages
}
impl Reply {
	async fn reply(&self, msg: RoutableMessage) -> Result<()> {
		println!("Replying...");
		match self {
			Reply::Direct(origin) => {
				let rt = ROUTING_TABLE.read().await;
				let route = rt.get(origin).unwrap();
				route.send(&Message::Routable(msg)).await?;
			}
		}
		Ok(())
	}
}

async fn handle_message(sender: Sender<VerifiedMessage>, VerifiedMessage {origin, message}: VerifiedMessage) -> Result<()> {
	// TODO: handle routed messages
	let reply = Arc::new(Reply::Direct(origin.clone()));

	println!("{:?}", message);

	match message {
		Message::Routable(RoutableMessage::Connect {
			sdp,
			ice
		}) => {
			let mut conn_table = CONNECTION_TABLE.write().await;
			if !conn_table.contains_key(&origin) {
				conn_table.insert(
					origin.clone(),
					create_connection(sender, origin.clone(), reply.clone()).await?
				);
			}
			let conn: &mut RTCPeerConnection = conn_table.get_mut(&origin).unwrap();
			if let Some(sdp) = sdp {
				if sdp.sdp_type == RTCSdpType::Offer {
					conn.set_remote_description(sdp).await?;
					let answer = conn.create_answer(None).await?;
					conn.set_local_description(answer).await?;
					reply.reply(RoutableMessage::Connect { 
						sdp: conn.local_description().await, ice: None
					}).await?;
				} else {
					conn.set_remote_description(sdp).await?;
				}
			}
			if let Some(ice) = ice {
				conn.add_ice_candidate(ice).await?;
			}
		},
		_ => {}
	}

	Ok(())
}