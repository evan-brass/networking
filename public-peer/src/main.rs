#![feature(once_cell)]
use std::error::Error;
use std::lazy::SyncLazy;
use std::collections::HashMap;

use tokio_tungstenite::accept_async;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;
use webrtc::data_channel::RTCDataChannel;

mod messages;
use messages::*;

static ROUTING_TABLE: SyncLazy<Mutex<HashMap<String, RTCDataChannel>>> = SyncLazy::new(|| {
	Mutex::new(HashMap::new())
});


#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
	let listener = TcpListener::bind("0.0.0.0:3030").await?;

	loop {
		let (stream, _addr) = listener.accept().await?;
		tokio::spawn(handle_conn(stream));
	}
}

async fn handle_conn(stream: TcpStream) {
	// TODO: make sure that CORS headers are being sent
	let mut ws = accept_async(stream).await.unwrap();
}

async fn handle_message(m: Message) {
	match m {
		Message::Error { msg } => {
			eprintln!("{:?}", msg);
		}
	}
}