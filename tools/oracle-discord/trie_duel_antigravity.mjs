/**
 * trie_duel_antigravity.mjs
 * 
 * Antigravity's solution for the Neural Duel.
 * Features: High-performance Trie, Recursive Wildcard DFS, Mermaid Dependency Graph.
 */

class TrieNode {
  constructor() {
    this.children = {};
    this.isEndOfWord = false;
    this.count = 0; // Usage frequency for Mermaid prioritizing
  }
}

class AntigravityTrie {
  constructor() {
    this.root = new TrieNode();
  }

  insert(word) {
    let node = this.root;
    for (const char of word) {
      if (!node.children[char]) {
        node.children[char] = new TrieNode();
      }
      node = node.children[char];
      node.count++;
    }
    node.isEndOfWord = true;
  }

  search(word) {
    return this._searchRecursive(this.root, word, 0);
  }

  _searchRecursive(node, word, index) {
    if (index === word.length) {
      return node.isEndOfWord;
    }

    const char = word[index];
    if (char === '.') {
      for (const key in node.children) {
        if (this._searchRecursive(node.children[key], word, index + 1)) {
          return true;
        }
      }
      return false;
    } else {
      if (!node.children[char]) return false;
      return this._searchRecursive(node.children[char], word, index + 1);
    }
  }

  generateMermaid(maxNodes = 20) {
    let diagram = "graph TD\n";
    let queue = [{ node: this.root, id: "root", label: "ROOT" }];
    let visited = 0;

    while (queue.length > 0 && visited < maxNodes) {
      const { node, id, label } = queue.shift();
      visited++;

      for (const char in node.children) {
        const childNode = node.children[char];
        const childId = `${id}_${char}`;
        diagram += `  ${id}["${label}"] --> ${childId}["${char} (${childNode.count})"]\n`;
        queue.push({ node: childNode, id: childId, label: char });
      }
    }
    return diagram;
  }
}

// --- TEST SUITE ---
const trie = new AntigravityTrie();
const words = ["food", "fold", "feet", "feat", "fast", "face", "fact", "fools", "football", "focus"];
words.forEach(w => trie.insert(w));

console.log("--- Antigravity Trie Duel ---");
console.log("Search 'food':", trie.search("food"));
console.log("Wildcard 'f..d':", trie.search("f..d")); // true (food, fold)
console.log("Wildcard 'fe.t':", trie.search("fe.t")); // true (feet, feat)
console.log("Wildcard 'f.st':", trie.search("f.st")); // true (fast)
console.log("Wildcard 'z...':", trie.search("z...")); // false

console.log("\n--- Generated Mermaid Diagram ---");
console.log(trie.generateMermaid(15));
