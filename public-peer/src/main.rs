use eyre::Result;
use stun::attributes::AttrType;
use stun::textattrs::TextAttribute;
use webrtc_ice::mdns::MulticastDnsMode;
use webrtc_util::Conn;
use std::collections::HashSet;
use std::net::SocketAddr;
use async_trait::async_trait;
use std::sync::Arc;

use tokio::net::UdpSocket;
use tokio::sync::mpsc::{channel, Sender};

use webrtc_ice::agent::{Agent, agent_config::AgentConfig};
use webrtc_ice::candidate::{CandidateType, Candidate};
use webrtc_ice::udp_mux::{UDPMuxDefault, UDPMuxParams, UDPMux};
use webrtc_ice::udp_network::UDPNetwork;
use webrtc_util::Result as ConResult;
use stun::message::Message;

struct CustomWrapper {
	pub inner: UdpSocket,
	pub local_ufrag: String,
	pub sender: Sender<String>
}
impl CustomWrapper {
	async fn handle_data(&self, data: &[u8]) {
		let mut msg = Message::new();
		if let Ok(()) = msg.unmarshal_binary(data) {
			if let Ok(TextAttribute { text: username, .. }) = TextAttribute::get_from_as(&msg, AttrType(6)) {
				if let Some((lufrag, rufrag)) = username.split_once(':') {
					if lufrag == self.local_ufrag {
						let _ = self.sender.send(rufrag.to_string()).await;
					}
				}
			}
		}
	}
}
#[async_trait]
impl Conn for CustomWrapper {
	async fn connect(&self, addr: SocketAddr) -> ConResult<()> {
		Ok(self.inner.connect(addr).await?)
	}

	async fn recv(&self, buf: &mut [u8]) -> ConResult<usize> {
		let ret = self.inner.recv(buf).await?;
		self.handle_data(&buf[..ret]).await;
		Ok(ret)
	}

	async fn recv_from(&self, buf: &mut [u8]) -> ConResult<(usize, SocketAddr)> {
		let ret = self.inner.recv_from(buf).await?;
		self.handle_data(&buf[..ret.0]).await;
		Ok(ret)
	}

	async fn send(&self, buf: &[u8]) -> ConResult<usize> {
		println!("{buf:?}");
		Ok(self.inner.send(buf).await?)
	}

	async fn send_to(&self, buf: &[u8], target: SocketAddr) -> ConResult<usize> {
		println!("{buf:?}");
		Ok(self.inner.send_to(buf, target).await?)
	}

	async fn local_addr(&self) -> ConResult<SocketAddr> {
		Ok(self.inner.local_addr()?)
	}

	async fn remote_addr(&self) -> Option<SocketAddr> {
		None
	}

	async fn close(&self) -> ConResult<()> {
		Ok(())
	}
}

async fn new_agent(udp_mux: Arc<UDPMuxDefault>, local_ufrag: String, local_pwd: String, rufrag: String) -> Result<()> {
	println!("Creating new agent: {local_ufrag}:{rufrag}");

	// let _conn = udp_mux.clone().get_conn(&rufrag).await?;

	let mut config = AgentConfig::default();
	config.lite = true;
	config.candidate_types = vec![CandidateType::Host];
	config.multicast_dns_mode = MulticastDnsMode::Disabled;
	config.is_controlling = false;
	config.udp_network = UDPNetwork::Muxed(udp_mux);
	config.local_ufrag = local_ufrag;
	config.local_pwd = local_pwd.clone();
	let (_cancel_tx, cancel_rx) = channel(1);
	let agent = Agent::new(config).await?;

	agent.on_candidate(Box::new(|candidate| Box::pin(async {
		if let Some(candidate) = candidate {
			println!("{candidate}");
		}
	}))).await;
	agent.on_connection_state_change(Box::new(|state| {
		println!("{state:?}");

		Box::pin(async {})
	})).await;
	agent.on_selected_candidate_pair_change(Box::new(|local_candidate, remote_candidate| {
		println!("{local_candidate} <-> {remote_candidate}");
		
		Box::pin(async {})
	})).await;

	// println!("About to set remote credentials");
	// agent.set_remote_credentials(rufrag.clone(), "unused-unused-unused-unused".into()).await?;

	println!("About to gather local candidates");
	agent.gather_candidates().await?;

	println!("About to try to accept the connection.");
	agent.accept(cancel_rx, rufrag, "unused-unused-unused-unused".into()).await?;
	println!("Connection accepted.");

	Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
	simple_logger::init()?;

	let socket = UdpSocket::bind("0.0.0.0:3333").await?;
	
	let local_ufrag = "iHa3".to_string();
	let local_pwd = "raj/XuQAfh/2sz1eDKTZbmgE".to_string();

	let (ufrag_tx, mut ufrag_rx) = channel(5);
	let socket = CustomWrapper {
		inner: socket,
		local_ufrag: local_ufrag.clone(),
		sender: ufrag_tx
	};

	let ice_port = UDPMuxDefault::new(UDPMuxParams::new(socket));

	let mut known_ufrags = HashSet::new();

	while let Some(rufrag) = ufrag_rx.recv().await {
		if !known_ufrags.contains(&rufrag) {
			known_ufrags.insert(rufrag.clone());
			tokio::spawn(new_agent(ice_port.clone(), local_ufrag.clone(), local_pwd.clone(), rufrag));
		}
	}

	Ok(())
}