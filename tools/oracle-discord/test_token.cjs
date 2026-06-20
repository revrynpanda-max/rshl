const { Client } = require("discord.js");
const token = "MTQ5OTAyMjI2NTk3MzYwNDM3Mg.G2G2WC.eGGRrnP1e7sk5McdB1hSkpkIjZxUXlfppGZwcQ";

console.log("Token length:", token.length);
console.log("Token hex:");
let hex = "";
for (let i = 0; i < token.length; i++) {
  hex += token.charCodeAt(i).toString(16).padStart(2, "0") + " ";
}
console.log(hex);

const client = new Client({ intents: [] });
client.login(token).then(() => {
  console.log("Login SUCCESS!");
  process.exit(0);
}).catch(err => {
  console.error("Login FAILED:", err.message);
  process.exit(1);
});
