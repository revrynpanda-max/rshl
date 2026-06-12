import json
import argparse
import sys
import os
import math
try:
    import torch
    import torch.nn as nn
    import torch.optim as optim
except ImportError:
    print("[train-mlp-gpu] Error: torch is not installed.")
    sys.exit(1)

def parse_sparse_vec(data, dim):
    vec = torch.zeros(dim, dtype=torch.float32)
    for idx, val in data.get('nz', []):
        vec[idx] = val
    return vec

class ResponseMlpSparse(nn.Module):
    def __init__(self, dim, hidden):
        super().__init__()
        self.dim = dim
        self.hidden = hidden
        self.w_in = nn.Linear(dim, hidden, bias=False)
        self.w_out = nn.Linear(hidden, dim, bias=False)
        
    def forward(self, x):
        # 1. Hidden activations
        h = torch.relu(self.w_in(x))
        # 2. Top-k sparsification (keep top 25%)
        k_hidden = max(1, int(math.ceil(self.hidden * 0.25)))
        topk_vals, topk_indices = torch.topk(h, k_hidden, dim=-1)
        h_sparse = torch.zeros_like(h)
        h_sparse.scatter_(-1, topk_indices, topk_vals)
        
        # 3. Output
        out = self.w_out(h_sparse)
        return out

def export_sparse_vec(dense_tensor, target_nnz):
    # Keep top target_nnz by absolute magnitude, signum them to -1, 1
    # dense_tensor is 1D
    abs_t = torch.abs(dense_tensor)
    if target_nnz >= len(abs_t):
        k = len(abs_t)
    else:
        k = target_nnz
    
    if k == 0:
        return {"len": len(dense_tensor), "nz": []}
        
    _, topk_indices = torch.topk(abs_t, k)
    
    nz = []
    # sort indices
    topk_indices = torch.sort(topk_indices).values
    for idx in topk_indices:
        val = dense_tensor[idx].item()
        sign = 1 if val >= 0 else -1
        nz.append([idx.item(), sign])
        
    return {"len": len(dense_tensor), "nz": nz}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--data', type=str, required=True, help="Path to mlp_batch.json")
    parser.add_argument('--out', type=str, required=True, help="Path to output response_mlp.json")
    parser.add_argument('--hidden', type=int, default=64)
    parser.add_argument('--epochs', type=int, default=10)
    args = parser.parse_args()

    print(f"[train-mlp-gpu] Loading {args.data}...")
    with open(args.data, 'r') as f:
        batch_data = json.load(f)
        
    dim = batch_data.get('dim', 16384)
    pairs = batch_data.get('pairs', [])
    
    if not pairs:
        print("[train-mlp-gpu] No pairs found!")
        sys.exit(1)
        
    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    print(f"[train-mlp-gpu] Using device: {device}")
    
    inputs = []
    targets = []
    for p in pairs:
        inputs.append(parse_sparse_vec(p['input'], dim))
        targets.append(parse_sparse_vec(p['target'], dim))
        
    x_tensor = torch.stack(inputs)
    y_tensor = torch.stack(targets)
    
    dataset = torch.utils.data.TensorDataset(x_tensor, y_tensor)
    dataloader = torch.utils.data.DataLoader(dataset, batch_size=1024, shuffle=True)
    
    model = ResponseMlpSparse(dim, args.hidden).to(device)
    
    # Initialize sparsely to match Rust
    with torch.no_grad():
        model.w_in.weight.data.normal_(0, 0.1)
        model.w_out.weight.data.normal_(0, 0.1)
        
    criterion = nn.MSELoss()
    optimizer = optim.Adam(model.parameters(), lr=0.01)
    
    print(f"[train-mlp-gpu] Training {len(pairs)} pairs for {args.epochs} epochs...")
    
    for epoch in range(args.epochs):
        model.train()
        total_loss = 0.0
        total_cos = 0.0
        batches = 0
        
        for bx, by in dataloader:
            bx = bx.to(device)
            by = by.to(device)
            
            optimizer.zero_grad()
            preds = model(bx)
            loss = criterion(preds, by)
            loss.backward()
            optimizer.step()
            
            total_loss += loss.item()
            with torch.no_grad():
                cos_sim = torch.nn.functional.cosine_similarity(preds, by, dim=1).mean().item()
                total_cos += cos_sim
            batches += 1
            
        avg_loss = total_loss / batches
        avg_cos = total_cos / batches
        print(f"[train-mlp-gpu] Epoch {epoch+1:2d} | loss = {avg_loss:.4f} | mean cosine = {avg_cos:.4f}")
        cos_sim = avg_cos # save for export

    # Export weights
    print(f"[train-mlp-gpu] Exporting weights to {args.out}...")
    model.eval()
    
    # Rust expects w_in to be list of SparseVec length `hidden` (64) each of size `dim` (16384)
    # model.w_in.weight is (hidden, dim)
    w_in_dense = model.w_in.weight.data.cpu()
    w_in_export = []
    target_nnz_in = int(math.ceil(dim * 0.04))
    for i in range(args.hidden):
        w_in_export.append(export_sparse_vec(w_in_dense[i], target_nnz_in))
        
    # Rust expects w_out to be list of SparseVec length `dim` (16384) each of size `hidden` (64)
    # model.w_out.weight is (dim, hidden)
    w_out_dense = model.w_out.weight.data.cpu()
    w_out_export = []
    target_nnz_out = max(1, int(math.ceil(args.hidden * 0.04)))
    for i in range(dim):
        w_out_export.append(export_sparse_vec(w_out_dense[i], target_nnz_out))
        
    final_state = {
        "dim": dim,
        "hidden": args.hidden,
        "w_in": w_in_export,
        "w_out": w_out_export,
        "learning_rate": 0.01,
        "train_steps": args.epochs,
        "final_cosine": cos_sim
    }
    
    with open(args.out, 'w') as f:
        json.dump(final_state, f)
        
    print("[train-mlp-gpu] Done!")

if __name__ == "__main__":
    main()
