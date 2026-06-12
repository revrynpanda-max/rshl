use axum::{http::StatusCode, response::IntoResponse};
use std::net::TcpListener;
use tokio::sync::Mutex;

struct OracleServer {
    listener: TcpListener,
}

impl OracleServer {
    fn new(listener: TcpListener) -> Self {
        OracleServer { listener }
    }

    async fn handle_connection(&self, stream: TcpStream) -> Result<(), Error> {
        let mut reader = BufReader::new(stream);
        let mut writer = BufWriter::new(stream);
        let mut line = String::new();
        reader.read_line(&mut line)?;
        println!("Received request: {}", line);
        writer.write_all(b"Hello, World!")?;
        Ok(())
    }
}
