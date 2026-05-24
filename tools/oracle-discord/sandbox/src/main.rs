use std::error::Error;
use tokio::sync::mpsc::{channel, Sender};
use crossterm::event::EventStream;
use ratatui::App;
use crate::lib::KaiCore as Kai;

fn main() -> Result<(), Box<dyn Error>> {
    let mut kai = Kai::new();
    
    // Check the status specs before starting the KAI RSHL UI server
    if !kai.check_status_specs()? {
        return Err("Status specs check failed".into());
    }

    let (tx, rx) = channel(10);
    
    // Start the KAI RSHL UI server
    kai.start_server(tx)?;
    
    // Check for status updates from the KAI RSHL engine and update the UI accordingly
    while let Some(status) = rx.recv().await {
        if !kai.check_status()? {
            return Err("Status check failed".into());
        }
        
        kai.update_ui(status)?;
    }
    
    Ok(())
}
