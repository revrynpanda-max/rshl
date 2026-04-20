use kai::core::SparseVec;

fn main() {
    let text = "geometric intelligence engine using RSHL architecture";
    let v = SparseVec::encode(text);
    println!("Text: {}", text);
    println!("NNZ: {}", v.nnz());
    println!("Data sum abs: {}", v.data.iter().map(|&x| x.abs() as i32).sum::<i32>());
    
    let v2 = SparseVec::encode(text);
    println!("Similarity to self: {}", v.cosine(&v2));
}
