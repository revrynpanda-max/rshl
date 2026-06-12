use axum::prelude::*;
use tokio::sync::mpsc::channel;
use serde_json::Value;
use std::collections::HashMap;
use ndarray::Array2;
use rayon::prelude::*;

// Struct for the lattice server
pub struct LatticeServer {
    // The lattice matrix
    pub lattice: Array2<f64>,
}

impl LatticeServer {
    // Function to initialize the lattice with a random seed
    fn init_lattice(&mut self, size: usize) {
        let (tx, rx) = channel(1);
        for i in 0..size {
            tx.send((i, f64::from_le_bytes(i.to_le_bytes()))).unwrap();
        }
        drop(tx);
        self.lattice = Array2::from_shape_vec((size, size), rx.iter().collect()).unwrap();
    }
}

// Implementation of the lattice server
impl LatticeServer {
    // Function to handle incoming requests
    async fn handle(&mut self, req: Request<Body>) -> Result<Response<Body>, BoxError> {
        let res = match (req.method(), req.uri().path()) {
            (&Method::POST, "/lattice") => self.handle_post(req).await?,
            _ => Response::builder()
                .status(StatusCode::NOT_FOUND)
                .body("".into())
                .unwrap(),
        };
        Ok(res)
    }
}
